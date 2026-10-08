// node generate-vapid.mjs
import { generateKeyPairSync } from 'node:crypto';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
console.log('VAPID_PUBLIC  =', pub);
console.log('VAPID_PRIVATE =', jwk.d);
console.log('\nاحفظ المفتاح الخاص سرًّا، ولا ترفعه على Git.');
