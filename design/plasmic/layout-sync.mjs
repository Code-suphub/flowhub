import {fileURLToPath} from 'node:url';
import {runLayoutCli} from './layout-engine.mjs';
runLayoutCli(fileURLToPath(new URL('../..',import.meta.url))).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
