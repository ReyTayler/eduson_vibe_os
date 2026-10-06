import {importStdin} from '../../packages/credentials/vault.mjs'
try{await importStdin()}catch(e){console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'KEY_IMPORT_FAILED');process.exitCode=1}
