// update.json に電子署名(Ed25519)を足す。 使い方: node tools/sign-update.mjs update.json  (秘密鍵は環境変数 UPDATE_SIGNING_KEY にPEMで入れる)
import fs from 'node:fs';
import crypto from 'node:crypto';
const file = process.argv[2] || 'update.json';
const pem = process.env.UPDATE_SIGNING_KEY;
if (!pem) { console.error('UPDATE_SIGNING_KEY がありません'); process.exit(1); }
const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const msg = ['nmv-update', j.version, j.sha256, j.size, j.electron].join('\n');
j.sig = crypto.sign(null, Buffer.from(msg), crypto.createPrivateKey(pem)).toString('base64');
fs.writeFileSync(file, JSON.stringify(j, null, 2));
console.log('署名しました: v' + j.version);
