// node scripts/make-module.mjs: build/index.js (tsc's one plain script) -> build/module.js, the ES module
// the shared Nakama server (imaNNeo/games, nakama/) takes: the same script with an export line added
// for FLAPPY_DASH_GAME and, by name, every function it lists (Nakama looks match handlers and RPCs up by
// their own top-level names). Run after `npx tsc`.
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync('build/index.js', 'utf8');
// run the script once in an empty sandbox to see which top-level names hold the game's functions
const box = {};
vm.runInNewContext(src + '\n;globalThis.__game = FLAPPY_DASH_GAME;', box);
const game = box.__game;
const names = new Set();
const nameOf = fn => { const n = Object.keys(box).find(k => box[k] === fn); if (!n) throw new Error('not a top-level function: ' + fn); names.add(n); };
for (const h of Object.values(game.matches)) Object.values(h).forEach(nameOf);
Object.values(game.rpcs).forEach(nameOf);
nameOf(game.setup);
fs.writeFileSync('build/module.js', src + `\nexport { ${[...names].join(', ')} };\nexport const game = FLAPPY_DASH_GAME;\n`);
console.log('build/module.js:', [...names].join(', '));
