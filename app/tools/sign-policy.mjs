// 利用できる最低バージョンの方針(policy.json)を作って、電子署名をつける。
// 使い方: MIN_VERSION=1.0.6 POLICY_MESSAGE="…" UPDATE_SIGNING_KEY="<PEM>" node tools/sign-policy.mjs policy.json
import fs from 'node:fs';
import crypto from 'node:crypto';
const out = process.argv[2] || 'policy.json';
const pem = process.env.UPDATE_SIGNING_KEY;
const minVersion = (process.env.MIN_VERSION || '').trim();
const message = (process.env.POLICY_MESSAGE || '').trim().slice(0, 300);
if (!pem) { console.error('UPDATE_SIGNING_KEY がありません'); process.exit(1); }
if (!/^\d+(\.\d+){1,2}$/.test(minVersion)) { console.error('MIN_VERSION は 1.0.6 の形で指定してください'); process.exit(1); }
const issued = Math.floor(Date.now() / 1000);
const msg = ['nmv-policy', minVersion, message, issued].join('\n');
const sig = crypto.sign(null, Buffer.from(msg), crypto.createPrivateKey(pem)).toString('base64');
fs.writeFileSync(out, JSON.stringify({ minVersion, message, issued, sig }, null, 2));
console.log(`方針を作りました: v${minVersion} 未満は利用不可`);
