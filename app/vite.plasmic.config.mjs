import {defineConfig,mergeConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import ordinary from './vite.config.mjs';
import {layoutDevPlugin} from '../design/plasmic/layout-engine.mjs';
export default defineConfig(mergeConfig(ordinary,{plugins:[layoutDevPlugin({root:fileURLToPath(new URL('..',import.meta.url))})]}));
