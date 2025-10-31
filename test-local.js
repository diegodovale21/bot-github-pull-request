#!/usr/bin/env node
/**
 * Script para testar localmente o bot de geração de PR
 *
 * Uso:
 *   node test-local.js                    # Testa com PR real (precisa GITHUB_TOKEN e repo)
 *   node test-local.js --pr-number=123    # Testa PR específico
 *   node test-local.js --dry-run          # Apenas gera body sem atualizar PR
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Parse argumentos
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const prNumberArg = args.find((arg) => arg.startsWith('--pr-number='));
const prNumber = prNumberArg ? parseInt(prNumberArg.split('=')[1]) : null;

// Detecta repo do git atual
let githubRepo = 'owner/repo';
try {
  const remoteUrl = execSync('git config --get remote.origin.url', {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  // Extrai owner/repo de URLs como https://github.com/owner/repo.git ou git@github.com:owner/repo.git
  const match = remoteUrl.match(
    /(?:github\.com[/:]|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (match) {
    githubRepo = `${match[1]}/${match[2].replace('.git', '')}`;
  }
} catch (e) {
  console.log(
    '⚠️  Não foi possível detectar repositório do git. Usando padrão.'
  );
}

// Se tem PR number, busca informações reais
let mockEvent;
if (prNumber && process.env.GITHUB_TOKEN) {
  console.log(`📡 Buscando informações do PR #${prNumber}...\n`);
  // Aqui você pode fazer uma chamada real à API se quiser
  mockEvent = {
    pull_request: {
      number: prNumber,
      head: {
        ref: `pr-branch-${prNumber}`,
      },
      user: {
        login: 'testuser',
      },
    },
    sender: {
      login: 'testuser',
    },
  };
} else {
  // Cria evento simulado do GitHub
  mockEvent = {
    pull_request: {
      number: prNumber || 1,
      head: {
        ref: 'test-branch',
      },
      user: {
        login: 'testuser',
      },
    },
    sender: {
      login: 'testuser',
    },
  };
}

// Cria arquivo de evento temporário
const eventPath = path.join(__dirname, '.github-event.json');
fs.writeFileSync(eventPath, JSON.stringify(mockEvent, null, 2));

// Configura variáveis de ambiente
const env = {
  ...process.env,
  GITHUB_EVENT_PATH: eventPath,
  GITHUB_REPOSITORY: githubRepo,
  GITHUB_ACTOR: 'testuser',
  GITHUB_TOKEN:
    process.env.GITHUB_TOKEN ||
    (dryRun ? 'ghp_test_token_invalid_for_dry_run' : null),
  DRY_RUN: dryRun ? 'true' : 'false',
  // OPENAI_API_KEY será lida do process.env se existir
};

console.log('🧪 Testando bot de geração de PR localmente...\n');
console.log('📦 Repositório:', githubRepo);
console.log('📝 Evento simulado:');
console.log(JSON.stringify(mockEvent, null, 2));
console.log('\n');

// Verifica configurações
if (!env.GITHUB_TOKEN && !dryRun) {
  console.log('⚠️  GITHUB_TOKEN não configurado.');
  console.log('   Configure: export GITHUB_TOKEN=ghp_sua_chave');
  console.log(
    '   Ou use --dry-run para apenas gerar o body sem fazer update\n'
  );
}

if (!env.OPENAI_API_KEY) {
  console.log('⚠️  OPENAI_API_KEY não configurada.');
  console.log('   O bot vai usar template padrão (sem LLM).');
  console.log('   Configure: export OPENAI_API_KEY=sua-chave');
  console.log('   Ou teste sem LLM primeiro\n');
} else {
  console.log('✅ OPENAI_API_KEY configurada. LLM será usado.\n');
}

if (dryRun) {
  console.log('🔍 Modo DRY-RUN: Apenas gerando body, sem atualizar PR\n');
}

console.log('─'.repeat(60));
console.log('');

try {
  // Executa o script
  const scriptPath = path.join(
    __dirname,
    '.github',
    'scripts',
    'generate-pr-body.js'
  );

  if (dryRun) {
    // Em modo dry-run, modifica temporariamente o script para não fazer update
    console.log(
      '💡 Dica: Em modo dry-run, o script tentará fazer update mas falhará com token inválido.'
    );
    console.log('   Isso é esperado e permite ver o body que seria gerado.\n');
  }

  const result = execSync(`node ${scriptPath}`, {
    env: env,
    cwd: __dirname,
    stdio: 'inherit',
  });

  console.log('\n' + '─'.repeat(60));
  console.log('✅ Teste concluído!');
  if (dryRun) {
    console.log('💡 Em modo dry-run, erros de API são esperados.');
  }
} catch (error) {
  console.log('\n' + '─'.repeat(60));
  if (
    (dryRun && error.message.includes('401')) ||
    error.message.includes('Bad credentials')
  ) {
    console.log('✅ Teste concluído (erro esperado em modo dry-run)!');
    console.log(
      '💡 O body foi gerado com sucesso. O erro é apenas porque o token é inválido.'
    );
  } else {
    console.error('❌ Erro durante o teste:', error.message);
    process.exit(1);
  }
} finally {
  // Limpa arquivo temporário
  if (fs.existsSync(eventPath)) {
    fs.unlinkSync(eventPath);
  }
}
