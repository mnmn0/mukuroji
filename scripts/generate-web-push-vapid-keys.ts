/**
 * Generates a VAPID key pair for Web Push.
 *
 * Prints the public key for the `WebPushVapidPublicKey` stack parameter and the private key to
 * store, as the whole secret string, in the Secrets Manager secret
 * `mukuroji/web-push/vapid-private-key`. Nothing is written to disk.
 */
import { createECDH } from 'node:crypto'

const ecdh = createECDH('prime256v1')
ecdh.generateKeys()
// The scalar is left-padded so it is always the 32 bytes the delivery worker expects.
const privateKey = Buffer.concat([Buffer.alloc(32 - ecdh.getPrivateKey().length), ecdh.getPrivateKey()])
console.log(`WebPushVapidPublicKey=${ecdh.getPublicKey().toString('base64url')}`)
console.log(`mukuroji/web-push/vapid-private-key=${privateKey.toString('base64url')}`)
