/**
 * Script Node.js que:
 * - lê .github/.bot.yml
 * - consulta as patches reais do PR via API
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
const OpenAI = require('openai');

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
 * Prepara o contexto das mudanças para o LLM
 */
async function prepareChangesContext(octokit, owner, repo, prNumber, config) {
  try {
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

    let context = 'Mudanças no Pull Request:\n\n';

    for (const file of files) {
      if (shouldIgnoreFile(file.filename, config)) {
        continue;
      }

      const status = file.status;
      const statusEmoji =
        status === 'added'
          ? '➕'
          : status === 'removed'
          ? '➖'
          : status === 'renamed'
          ? '🔄'
          : '✏️';

      context += `${statusEmoji} ${file.filename} (${status})\n`;

      if (file.additions)
        context += `  +${file.additions} linhas adicionadas\n`;
      if (file.deletions) context += `  -${file.deletions} linhas removidas\n`;

      // Adiciona um resumo do patch (limitado para não exceder tokens)
      if (file.patch) {
        const patchLines = file.patch.split('\n').slice(0, 30); // Limita a 30 linhas
        context += `\n  Diferenças:\n${patchLines.join('\n')}\n`;
      }

      context += '\n';
    }

    return context;
  } catch (error) {
    console.error('Erro ao preparar contexto:', error.message);
    return 'Erro ao analisar mudanças.';
  }
}

/**
 * Gera descrição inteligente usando LLM
 */
async function generateLLMDescription(changesContext, prTitle, config) {
  const rules = config.rules || {};
  const llmConfig = rules.llm || {};

  if (!rules.use_llm || llmConfig.provider !== 'openai') {
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ OPENAI_API_KEY não configurada. Pulando geração com LLM.');
    return null;
  }

  try {
    const openai = new OpenAI({ apiKey });
    const sections = (config.templates && config.templates.sections) || [];

    // Prepara prompt com as seções do template
    const sectionInstructions = sections
      .map((s) => {
        const sectionName = s.title.toLowerCase();
        if (
          sectionName.includes('problema') ||
          sectionName.includes('contexto')
        ) {
          return `- **${s.title}**: Analise as mudanças e identifique qual problema ou contexto motivou essas alterações.`;
        } else if (
          sectionName.includes('solução') ||
          sectionName.includes('proposta')
        ) {
          return `- **${s.title}**: Descreva a solução implementada, principais mudanças técnicas e decisões arquiteturais.`;
        } else if (
          sectionName.includes('testar') ||
          sectionName.includes('teste')
        ) {
          return `- **${s.title}**: Sugira passos para testar e validar as mudanças.`;
        }
        return `- **${s.title}**: ${s.placeholder || ''}`;
      })
      .join('\n');

    const sectionTitles = sections.map((s) => s.title).join(', ');

    const prompt = `Você é um assistente especializado em analisar Pull Requests. Analise as seguintes mudanças e gere uma descrição estruturada do PR.

**Mudanças:**
${changesContext}

**Instruções:**
Gere uma descrição profissional em português brasileiro, preenchendo as seguintes seções nesta ordem exata:
${sectionInstructions}

**Formato de resposta obrigatório:**
Para cada seção, use exatamente este formato:
**Nome da Seção:**
Conteúdo da seção aqui...

Exemplo:
**Qual o problema / Contexto:**
Este PR resolve o problema de...

**Solução proposta:**
A solução implementa...

IMPORTANTE: Use o formato **Título da Seção:** seguido de quebra de linha e o conteúdo. Use exatamente os títulos: ${sectionTitles}

**Requisitos:**
- Seja específico e técnico
- Mencione arquivos e funcionalidades alteradas quando relevante
- Use linguagem clara e objetiva
- Respeite o formato exato acima
- Preencha TODAS as seções solicitadas`;

    const response = await openai.chat.completions.create({
      model: llmConfig.model || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Você é um assistente especializado em documentar Pull Requests de forma técnica e profissional.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: llmConfig.temperature || 0.7,
      max_tokens: llmConfig.max_tokens || 1000,
    });

    const generatedContent = response.choices[0]?.message?.content || '';
    return generatedContent.trim();
  } catch (error) {
    console.error('Erro ao gerar descrição com LLM:', error.message);
    return null;
  }
}

/**
 * Parseia a resposta do LLM e preenche as seções
 */
function parseLLMResponse(llmResponse, sections) {
  const parsed = {};
  const lines = llmResponse.split('\n');
  let currentSection = null;
  let currentContent = [];

  // Mapeia títulos das seções para identificação
  const sectionMap = {};
  for (const s of sections) {
    const key = s.title.toLowerCase();
    sectionMap[key] = s.title;
    // Também adiciona variações comuns
    if (key.includes('problema')) sectionMap['problema'] = s.title;
    if (key.includes('contexto')) sectionMap['contexto'] = s.title;
    if (key.includes('solução')) sectionMap['solução'] = s.title;
    if (key.includes('proposta')) sectionMap['proposta'] = s.title;
    if (key.includes('testar')) sectionMap['testar'] = s.title;
    if (key.includes('teste')) sectionMap['teste'] = s.title;
  }

  for (const line of lines) {
    // Detecta início de seção em vários formatos
    let sectionTitle = null;

    // Formato: ## Título
    let match = line.match(/^##\s*(.+)$/);
    if (match) {
      sectionTitle = match[1].trim().toLowerCase();
    }

    // Formato: **Título** ou *Título*
    if (!sectionTitle) {
      match = line.match(/^\*\*?\s*(.+?)\s*\*?\*?$/);
      if (match && line.includes('**')) {
        sectionTitle = match[1].trim().toLowerCase();
      }
    }

    // Formato: Título: (sem markdown)
    if (!sectionTitle) {
      match = line.match(/^(.+?):\s*$/);
      if (match && match[1].length < 50) {
        sectionTitle = match[1].trim().toLowerCase();
      }
    }

    if (sectionTitle) {
      // Salva seção anterior
      if (currentSection && currentContent.length > 0) {
        parsed[currentSection] = currentContent.join('\n').trim();
      }

      // Mapeia para a seção correta
      for (const key in sectionMap) {
        if (sectionTitle.includes(key) || key.includes(sectionTitle)) {
          currentSection = sectionMap[key].toLowerCase();
          currentContent = [];
          break;
        }
      }

      // Se não encontrou mapeamento, tenta usar diretamente
      if (!currentSection && sectionMap[sectionTitle]) {
        currentSection = sectionMap[sectionTitle].toLowerCase();
        currentContent = [];
      }

      continue;
    }

    // Adiciona conteúdo à seção atual
    if (currentSection && line.trim()) {
      currentContent.push(line);
    } else if (!currentSection && line.trim() && !line.match(/^[-*]\s*$/)) {
      // Se não há seção definida mas há conteúdo, pode ser que o LLM não formatou
      // Tenta associar ao primeiro conteúdo encontrado
      if (sections.length > 0 && !parsed[sections[0].title.toLowerCase()]) {
        currentSection = sections[0].title.toLowerCase();
        currentContent = [line];
      }
    }
  }

  // Adiciona último conteúdo
  if (currentSection && currentContent.length > 0) {
    parsed[currentSection] = currentContent.join('\n').trim();
  }

  return parsed;
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

  // Tenta gerar descrição com LLM se habilitado
  let llmContent = null;
  const rules = config.rules || {};
  if (rules.use_llm) {
    try {
      const changesContext = await prepareChangesContext(
        octokit,
        owner,
        repo,
        prNumber,
        config
      );
      llmContent = await generateLLMDescription(changesContext, title, config);

      if (llmContent) {
        const parsedSections = parseLLMResponse(llmContent, sections);

        // Preenche seções com conteúdo do LLM ou placeholder
        for (const s of sections) {
          body += `## ${s.title}\n\n`;
          const sectionKey = s.title.toLowerCase();
          const llmText = parsedSections[sectionKey];

          if (llmText) {
            body += `${llmText}\n\n`;
          } else {
            // Fallback: busca no conteúdo completo
            const sectionLower = s.title.toLowerCase();
            let found = false;
            for (const key in parsedSections) {
              if (sectionLower.includes(key) || key.includes(sectionLower)) {
                body += `${parsedSections[key]}\n\n`;
                found = true;
                break;
              }
            }
            if (!found) {
              body += `${s.placeholder || ''}\n\n`;
            }
          }
        }
      }
    } catch (error) {
      console.error('Erro ao usar LLM, usando template padrão:', error.message);
    }
  }

  // Se LLM não foi usado ou falhou, usa template padrão
  if (!llmContent) {
    for (const s of sections) {
      body += `## ${s.title}\n\n`;
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
    const { data: currentPR } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      {
        owner,
        repo: repoName,
        pull_number: prNumber,
      }
    );

    const currentBody = currentPR.body || '';

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
