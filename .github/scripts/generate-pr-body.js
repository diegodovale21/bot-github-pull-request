/**
 * Script Node.js que:
 * - lê .github/.bot.yml
 * - consulta as patches reais do PR via API
 * - analisa mudanças e gera descrição inteligente usando heurísticas
 * - monta o body do PR com template + changelist baseado nas mudanças
 * - usa Octokit para atualizar o PR atual
 * - Proteções: evita loop (checa sender), preserva texto de usuário com delimitadores,
 *   só atualiza quando há mudança real
 *
 * Requer: npm i js-yaml @octokit/core
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Octokit } = require('@octokit/core');

const BOT_START_MARKER = '<!-- BOT_START -->';
const BOT_END_MARKER = '<!-- BOT_END -->';

/**
 * Carrega configuração do bot
 */
function loadBotConfig() {
  // Determina o caminho base do repositório
  // No GitHub Actions, process.cwd() já está na raiz do repositório
  let configPath;

  // Primeiro tenta encontrar relativo ao diretório atual (raiz do repo no GitHub Actions)
  const rootPath = path.resolve(process.cwd());
  const configAtRoot = path.join(rootPath, '.github', '.bot.yml');

  // Se não encontrar, tenta relativo ao script (para desenvolvimento local)
  if (fs.existsSync(configAtRoot)) {
    configPath = configAtRoot;
  } else {
    // Se o script está em .github/scripts, sobe dois níveis até a raiz
    const scriptDir = __dirname;
    configPath = path.resolve(scriptDir, '..', '..', '.github', '.bot.yml');
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Arquivo de configuração não encontrado: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf8');
  return yaml.load(content);
}

/**
 * Verifica se um arquivo deve ser ignorado baseado nas regras de configuração
 */
function shouldIgnoreFile(filename, config) {
  const rules = config.rules || {};

  // Verifica extensões ignoradas
  if (rules.ignore_extensions) {
    const ext = path.extname(filename).toLowerCase();
    if (rules.ignore_extensions.includes(ext)) {
      return true;
    }
  }

  // Verifica patterns ignorados
  if (rules.ignore_patterns) {
    for (const pattern of rules.ignore_patterns) {
      // Conversão simples de glob para regex
      const regex = new RegExp(
        pattern
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
          .replace(/\//g, '\\/')
      );
      if (regex.test(filename)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extrai informações úteis de um patch
 */
function extractPatchSummary(patch, maxLines = 50) {
  if (!patch || !patch.length) return '';

  const lines = patch.split('\n');
  const relevantLines = [];
  let added = 0;
  let removed = 0;
  let context = 0;

  for (let i = 0; i < Math.min(lines.length, maxLines * 3); i++) {
    const line = lines[i];
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
      relevantLines.push(line);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
      relevantLines.push(line);
    } else if (line.startsWith(' ')) {
      context++;
      if (context < 5) {
        // Mantém um pouco de contexto
        relevantLines.push(line);
      }
    }
  }

  // Limita número de linhas exibidas
  const displayLines = relevantLines.slice(0, maxLines);
  const summary = displayLines.join('\n');

  // Adiciona indicador se foi truncado
  const truncNote =
    lines.length > maxLines * 3
      ? `\n... (${lines.length - displayLines.length} linhas omitidas)`
      : '';

  return `\`\`\`diff\n${summary}${truncNote}\n\`\`\``;
}

/**
 * Gera changelist baseado nos arquivos modificados do PR
 */
async function generateChangelist(octokit, owner, repo, prNumber, config) {
  const rules = config.rules || {};
  const maxExcerptLines = rules.max_excerpt_lines || 50;

  try {
    // Busca os arquivos modificados no PR
    const { data: files } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
      {
        owner,
        repo,
        pull_number: prNumber,
      }
    );

    if (!files || files.length === 0) {
      return 'Nenhum arquivo modificado.';
    }

    let changelist = '### Arquivos modificados\n\n';

    // Agrupa arquivos por status
    const added = [];
    const modified = [];
    const removed = [];
    const renamed = [];

    for (const file of files) {
      if (shouldIgnoreFile(file.filename, config)) {
        continue;
      }

      const status = file.status;
      const entry = {
        filename: file.filename,
        additions: file.additions || 0,
        deletions: file.deletions || 0,
        changes: file.changes || 0,
        patch: file.patch || '',
      };

      if (status === 'added') {
        added.push(entry);
      } else if (status === 'removed') {
        removed.push(entry);
      } else if (status === 'renamed') {
        renamed.push(entry);
      } else {
        modified.push(entry);
      }
    }

    // Exibe arquivos adicionados
    if (added.length > 0) {
      changelist += `#### ➕ Adicionados (${added.length})\n\n`;
      for (const file of added) {
        changelist += `- \`${file.filename}\` (+${file.additions})\n`;
        if (file.patch && maxExcerptLines > 0) {
          const summary = extractPatchSummary(file.patch, maxExcerptLines);
          if (summary) {
            changelist += `${summary}\n\n`;
          }
        }
      }
      changelist += '\n';
    }

    // Exibe arquivos modificados
    if (modified.length > 0) {
      changelist += `#### ✏️ Modificados (${modified.length})\n\n`;
      for (const file of modified) {
        const changeStr =
          file.additions > 0 || file.deletions > 0
            ? ` (+${file.additions}/-${file.deletions})`
            : '';
        changelist += `- \`${file.filename}\`${changeStr}\n`;
        if (file.patch && maxExcerptLines > 0) {
          const summary = extractPatchSummary(file.patch, maxExcerptLines);
          if (summary) {
            changelist += `${summary}\n\n`;
          }
        }
      }
      changelist += '\n';
    }

    // Exibe arquivos removidos
    if (removed.length > 0) {
      changelist += `#### ➖ Removidos (${removed.length})\n\n`;
      for (const file of removed) {
        changelist += `- \`${file.filename}\` (-${file.deletions})\n`;
      }
      changelist += '\n';
    }

    // Exibe arquivos renomeados
    if (renamed.length > 0) {
      changelist += `#### 🔄 Renomeados (${renamed.length})\n\n`;
      for (const file of renamed) {
        changelist += `- \`${file.previous_filename || '?'}\` → \`${
          file.filename
        }\`\n`;
      }
      changelist += '\n';
    }

    return changelist.trim();
  } catch (error) {
    console.error('Erro ao gerar changelist:', error.message);
    return 'Erro ao gerar lista de arquivos modificados.';
  }
}

/**
 * Extrai conteúdo preservado do usuário (fora dos delimitadores)
 */
function extractPreservedContent(currentBody, useDelimiters) {
  if (!useDelimiters || !currentBody) {
    return { before: '', after: '', botContent: currentBody || '' };
  }

  const startIdx = currentBody.indexOf(BOT_START_MARKER);
  const endIdx = currentBody.indexOf(BOT_END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    // Delimitadores não encontrados, retorna tudo como botContent
    return { before: '', after: '', botContent: currentBody || '' };
  }

  const before = currentBody.substring(0, startIdx).trim();
  const after = currentBody.substring(endIdx + BOT_END_MARKER.length).trim();
  const botContent = currentBody
    .substring(startIdx + BOT_START_MARKER.length, endIdx)
    .trim();

  return { before, after, botContent };
}

/**
 * Gera descrição inteligente baseada em heurísticas (sem LLM)
 */
function generateSmartDescription(files, config) {
  const rules = config.rules || {};

  if (!rules.use_smart_description) {
    return null;
  }

  console.log('🧠 Gerando descrição inteligente usando heurísticas...');

  try {
    // Analisa os arquivos modificados
    const analysis = analyzeChanges(files, config);

    const sections = (config.templates && config.templates.sections) || [];
    const result = {};

    for (const section of sections) {
      const sectionName = section.title.toLowerCase();

      if (
        sectionName.includes('problema') ||
        sectionName.includes('contexto')
      ) {
        result[section.title.toLowerCase()] = generateProblemContext(analysis);
      } else if (
        sectionName.includes('solução') ||
        sectionName.includes('proposta')
      ) {
        result[section.title.toLowerCase()] = generateSolution(analysis);
      } else if (
        sectionName.includes('testar') ||
        sectionName.includes('teste')
      ) {
        result[section.title.toLowerCase()] = generateTestingSteps(analysis);
      }
    }

    return result;
  } catch (error) {
    console.error('Erro ao gerar descrição inteligente:', error.message);
    return null;
  }
}

/**
 * Analisa as mudanças e extrai informações úteis
 */
function analyzeChanges(files, config) {
  const analysis = {
    fileTypes: {},
    categories: [],
    totalAdditions: 0,
    totalDeletions: 0,
    newFiles: [],
    modifiedFiles: [],
    removedFiles: [],
    configFiles: [],
    testFiles: [],
    frontendFiles: [],
    backendFiles: [],
    docsFiles: [],
  };

  for (const file of files) {
    if (shouldIgnoreFile(file.filename, config)) {
      continue;
    }

    const ext = path.extname(file.filename).toLowerCase();
    const filename = path.basename(file.filename).toLowerCase();
    const dir = path.dirname(file.filename).toLowerCase();

    analysis.totalAdditions += file.additions || 0;
    analysis.totalDeletions += file.deletions || 0;

    // Categoriza por tipo de arquivo
    if (ext === '.js' || ext === '.ts' || ext === '.jsx' || ext === '.tsx') {
      analysis.fileTypes[ext] = (analysis.fileTypes[ext] || 0) + 1;
    }

    // Categoriza por status
    if (file.status === 'added') {
      analysis.newFiles.push(file.filename);
    } else if (file.status === 'removed') {
      analysis.removedFiles.push(file.filename);
    } else {
      analysis.modifiedFiles.push(file.filename);
    }

    // Categoriza por tipo de mudança
    if (
      filename.includes('test') ||
      filename.includes('spec') ||
      dir.includes('test')
    ) {
      analysis.testFiles.push(file.filename);
      analysis.categories.push('testes');
    }

    if (
      filename.includes('config') ||
      filename.includes('conf') ||
      ext === '.yml' ||
      ext === '.yaml' ||
      filename === 'package.json' ||
      filename === 'package-lock.json'
    ) {
      analysis.configFiles.push(file.filename);
      analysis.categories.push('configuração');
    }

    if (
      ext === '.html' ||
      ext === '.css' ||
      ext === '.scss' ||
      ext === '.vue' ||
      dir.includes('frontend') ||
      dir.includes('client') ||
      dir.includes('ui')
    ) {
      analysis.frontendFiles.push(file.filename);
      analysis.categories.push('frontend');
    }

    if (
      ext === '.py' ||
      ext === '.java' ||
      ext === '.go' ||
      ext === '.rb' ||
      dir.includes('backend') ||
      dir.includes('server') ||
      dir.includes('api')
    ) {
      analysis.backendFiles.push(file.filename);
      analysis.categories.push('backend');
    }

    if (
      ext === '.md' ||
      filename.includes('readme') ||
      filename.includes('docs')
    ) {
      analysis.docsFiles.push(file.filename);
      analysis.categories.push('documentação');
    }
  }

  return analysis;
}

/**
 * Gera descrição do problema/contexto baseado na análise
 */
function generateProblemContext(analysis) {
  const parts = [];

  if (analysis.removedFiles.length > 0) {
    parts.push(
      `Remove ${analysis.removedFiles.length} arquivo(s) obsoleto(s).`
    );
  }

  if (analysis.testFiles.length > 0) {
    parts.push(`Adiciona/melhor a cobertura de testes.`);
  }

  if (analysis.configFiles.length > 0) {
    parts.push(`Atualiza configurações do projeto.`);
  }

  if (analysis.frontendFiles.length > 0 && analysis.backendFiles.length === 0) {
    parts.push(`Implementa melhorias na interface do usuário.`);
  }

  if (analysis.backendFiles.length > 0 && analysis.frontendFiles.length === 0) {
    parts.push(`Implementa melhorias na lógica de negócio/API.`);
  }

  if (analysis.newFiles.length > 0 && analysis.modifiedFiles.length === 0) {
    parts.push(`Adiciona nova funcionalidade.`);
  }

  if (analysis.totalDeletions > analysis.totalAdditions * 1.5) {
    parts.push(`Refatora código removendo código obsoleto ou duplicado.`);
  }

  if (parts.length === 0) {
    parts.push(
      `Implementa mudanças no código baseado nos arquivos modificados.`
    );
  }

  return parts.join(' ') || 'Este PR implementa mudanças no código.';
}

/**
 * Gera descrição da solução baseado na análise
 */
function generateSolution(analysis) {
  const parts = [];

  if (analysis.newFiles.length > 0) {
    const newFilesList = analysis.newFiles
      .slice(0, 3)
      .map((f) => `\`${f}\``)
      .join(', ');
    parts.push(
      `**Arquivos adicionados:** ${newFilesList}${
        analysis.newFiles.length > 3 ? '...' : ''
      }`
    );
  }

  if (analysis.modifiedFiles.length > 0) {
    const modifiedList = analysis.modifiedFiles
      .slice(0, 3)
      .map((f) => `\`${f}\``)
      .join(', ');
    parts.push(
      `**Arquivos modificados:** ${modifiedList}${
        analysis.modifiedFiles.length > 3 ? '...' : ''
      }`
    );
  }

  const stats = [];
  if (analysis.totalAdditions > 0) {
    stats.push(`+${analysis.totalAdditions} linhas`);
  }
  if (analysis.totalDeletions > 0) {
    stats.push(`-${analysis.totalDeletions} linhas`);
  }
  if (stats.length > 0) {
    parts.push(`**Estatísticas:** ${stats.join(', ')}`);
  }

  if (analysis.categories.length > 0) {
    const uniqueCategories = [...new Set(analysis.categories)];
    parts.push(`**Categorias:** ${uniqueCategories.join(', ')}`);
  }

  if (parts.length === 0) {
    parts.push('Modificações nos arquivos do projeto.');
  }

  return parts.join('\n\n');
}

/**
 * Gera passos de teste baseado na análise
 */
function generateTestingSteps(analysis) {
  const steps = [];

  if (analysis.frontendFiles.length > 0) {
    steps.push('1. Testar a interface em diferentes navegadores');
    steps.push('2. Verificar responsividade em dispositivos móveis');
  }

  if (analysis.backendFiles.length > 0) {
    steps.push('1. Executar testes unitários');
    steps.push('2. Testar endpoints da API');
  }

  if (analysis.testFiles.length > 0) {
    steps.push('1. Executar suite de testes');
    steps.push('2. Verificar cobertura de testes');
  }

  if (analysis.configFiles.length > 0) {
    steps.push('1. Verificar se as configurações foram aplicadas corretamente');
  }

  if (steps.length === 0) {
    steps.push('1. Verificar se as mudanças funcionam como esperado');
    steps.push('2. Testar os cenários principais');
  }

  return steps.join('\n');
}

/**
 * Constrói o body do PR
 */
async function buildBody(config, event, octokit, owner, repo, prNumber) {
  const branch = event.pull_request.head.ref || '';
  const titleTemplate =
    (config.templates && config.templates.default_title) || 'PR: {branch}';
  const title = titleTemplate.replace('{branch}', branch);

  const sections = (config.templates && config.templates.sections) || [];
  let body = `# ${title}\n\n`;

  // Busca arquivos do PR para análise
  let files = [];
  try {
    const { data: prFiles } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
      {
        owner,
        repo,
        pull_number: prNumber,
      }
    );
    files = prFiles || [];
  } catch (error) {
    console.warn('⚠️  Não foi possível buscar arquivos do PR:', error.message);
  }

  // Tenta gerar descrição inteligente (sem LLM) primeiro
  let smartDescription = null;
  const rules = config.rules || {};

  if (rules.use_smart_description && files.length > 0) {
    smartDescription = generateSmartDescription(files, config);
    if (smartDescription) {
      console.log('✅ Descrição inteligente gerada usando heurísticas');
    }
  }

  // Preenche seções com descrição gerada ou placeholder
  for (const s of sections) {
    body += `## ${s.title}\n\n`;

    let sectionContent = null;
    if (smartDescription) {
      const sectionKey = s.title.toLowerCase();
      sectionContent = smartDescription[sectionKey];

      // Busca flexível se não encontrou pela chave exata
      if (!sectionContent && typeof smartDescription === 'object') {
        const sectionLower = s.title.toLowerCase();
        const keywords = sectionLower.split(/[\s\/]+/);
        for (const key in smartDescription) {
          const keyLower = key.toLowerCase();
          if (
            keywords.some(
              (kw) => keyLower.includes(kw) || kw.includes(keyLower)
            )
          ) {
            sectionContent = smartDescription[key];
            break;
          }
        }
      }
    }

    if (sectionContent && sectionContent.length > 10) {
      body += `${sectionContent}\n\n`;
    } else {
      // Fallback: usa placeholder
      body += `${s.placeholder || ''}\n\n`;
    }
  }

  // Adiciona changelist se configurado
  if (config.rules && config.rules.include_changelist) {
    const changelist = await generateChangelist(
      octokit,
      owner,
      repo,
      prNumber,
      config
    );
    body += `${changelist}\n\n`;
  }

  // Adiciona footer
  if (config.templates && config.templates.footer) {
    body += `---\n${config.templates.footer}\n`;
  }

  return body.trim();
}

/**
 * Verifica se o PR já possui uma descrição válida (não vazia e não só placeholders)
 */
function hasExistingDescription(currentBody, config) {
  if (!currentBody || typeof currentBody !== 'string') {
    return false;
  }

  const normalizedBody = currentBody.trim();

  // Se estiver vazio, não tem descrição
  if (normalizedBody.length === 0) {
    return false;
  }

  // Remove delimitadores do bot para análise
  let bodyToCheck = normalizedBody;
  const rules = config.rules || {};
  if (rules.use_delimiters) {
    const preserved = extractPreservedContent(normalizedBody, true);
    // Se há conteúdo fora dos delimitadores, considera que já tem descrição do usuário
    if (preserved.before.trim() || preserved.after.trim()) {
      return true;
    }
    bodyToCheck = preserved.botContent.trim();

    // Se dentro dos delimitadores está vazio, não tem descrição
    if (bodyToCheck.length === 0) {
      return false;
    }
  }

  // Verifica se contém apenas placeholders padrão
  const sections = (config.templates && config.templates.sections) || [];
  const placeholders = sections
    .map((s) => s.placeholder)
    .filter(Boolean)
    .map((p) => p.trim().toLowerCase());

  // Se não há placeholders configurados, verifica apenas comprimento
  if (placeholders.length === 0) {
    return bodyToCheck.length > 50; // Mínimo de 50 caracteres
  }

  const bodyLower = bodyToCheck.toLowerCase();

  // Verifica se TODOS os placeholders estão presentes (indica que é só template)
  let allPlaceholdersPresent = true;
  for (const placeholder of placeholders) {
    if (placeholder && !bodyLower.includes(placeholder)) {
      allPlaceholdersPresent = false;
      break;
    }
  }

  // Se todos os placeholders estão presentes E o body é pequeno, provavelmente é só template
  if (allPlaceholdersPresent && bodyToCheck.length < 200) {
    return false;
  }

  // Se tem conteúdo significativo (mais que 100 caracteres) e não são só placeholders
  // OU se algum placeholder não está presente (usuário preencheu), tem descrição
  const hasSignificantContent = bodyToCheck.length > 100;
  const hasCustomContent = !allPlaceholdersPresent;

  return hasSignificantContent || hasCustomContent;
}

/**
 * Verifica se deve atualizar o PR (evita loop e atualizações desnecessárias)
 */
function shouldUpdatePR(event, config, currentBody, newBody) {
  const rules = config.rules || {};
  const botName = rules.bot_name || 'github-actions[bot]';

  // Evita loop: não atualiza se o sender for o próprio bot
  const sender = event.sender?.login || event.pull_request?.user?.login;
  if (sender === botName) {
    console.log(`Ignorando: sender é o próprio bot (${botName})`);
    return false;
  }

  // Remove espaços em branco para comparação
  const normalizedCurrent = (currentBody || '').trim().replace(/\s+/g, ' ');
  const normalizedNew = newBody.trim().replace(/\s+/g, ' ');

  // Se usar delimitadores, compara apenas o conteúdo entre eles
  if (rules.use_delimiters && currentBody) {
    const preserved = extractPreservedContent(currentBody, true);
    const preservedNew = extractPreservedContent(newBody, false);

    // Compara apenas o conteúdo do bot
    if (
      preserved.botContent.trim().replace(/\s+/g, ' ') ===
      preservedNew.botContent.trim().replace(/\s+/g, ' ')
    ) {
      console.log('Ignorando: conteúdo do bot não mudou');
      return false;
    }
  } else {
    // Compara todo o body
    if (normalizedCurrent === normalizedNew) {
      console.log('Ignorando: body não mudou');
      return false;
    }
  }

  return true;
}

/**
 * Função principal
 */
async function main() {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
      throw new Error('GITHUB_EVENT_PATH não definido');
    }

    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    if (!event.pull_request) {
      console.log('Evento não é de pull_request — nada a fazer');
      return;
    }

    const config = loadBotConfig();
    const repo = process.env.GITHUB_REPOSITORY; // owner/repo
    const [owner, repoName] = repo.split('/');
    const prNumber = event.pull_request.number;

    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

    // Busca o PR atual para obter o body existente
    let currentBody = '';
    try {
      const { data: currentPR } = await octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner,
          repo: repoName,
          pull_number: prNumber,
        }
      );
      currentBody = currentPR.body || '';
    } catch (error) {
      // Se o PR não existe ou há erro de autenticação (em modo dry-run), simula PR vazio
      if (
        process.env.DRY_RUN === 'true' ||
        error.status === 404 ||
        error.status === 401
      ) {
        console.log(
          '⚠️  Não foi possível buscar PR (esperado em modo dry-run). Simulando PR sem descrição.'
        );
        currentBody = '';
      } else {
        throw error;
      }
    }

    // Em modo dry-run, força PR sem descrição para teste
    if (process.env.DRY_RUN === 'true') {
      currentBody = '';
      console.log('🧪 Modo dry-run: Forçando PR sem descrição para teste.');
    }

    // Verifica se o PR já possui uma descrição
    if (hasExistingDescription(currentBody, config)) {
      console.log('ℹ️  PR já possui descrição. Bot não irá alterar.');
      return;
    }

    console.log('📝 PR não possui descrição. Gerando automaticamente...');

    // Constrói o novo body
    const newBody = await buildBody(
      config,
      event,
      octokit,
      owner,
      repoName,
      prNumber
    );

    // Verifica se deve atualizar (evita loop)
    if (!shouldUpdatePR(event, config, currentBody, newBody)) {
      console.log('PR não será atualizado (loop evitado)');
      return;
    }

    // Monta o body final com delimitadores se necessário
    let finalBody = newBody;
    const rules = config.rules || {};
    if (rules.use_delimiters) {
      const preserved = extractPreservedContent(currentBody, true);
      finalBody = [
        preserved.before,
        BOT_START_MARKER,
        newBody,
        BOT_END_MARKER,
        preserved.after,
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    // Se DRY_RUN estiver configurado, apenas exibe o body sem atualizar
    if (process.env.DRY_RUN === 'true') {
      console.log('\n' + '═'.repeat(60));
      console.log('📄 BODY GERADO (DRY RUN - não foi atualizado no PR):');
      console.log('═'.repeat(60));
      console.log(finalBody);
      console.log('═'.repeat(60));
      console.log('\n✅ Body gerado com sucesso (modo dry-run)');
      return;
    }

    // Atualiza o PR
    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo: repoName,
      pull_number: prNumber,
      body: finalBody,
    });

    console.log('✅ Descrição do PR atualizada com sucesso.');
  } catch (err) {
    console.error('❌ Erro ao gerar/atualizar descrição do PR:', err);
    process.exit(1);
  }
}

main();
