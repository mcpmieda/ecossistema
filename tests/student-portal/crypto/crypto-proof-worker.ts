import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';

// Disposable local test harness; no bindings, database, real credentials or production route.
export default {
  async fetch() {
    const cryptography = new PortalCryptoV1(
      new Map([[1, new Uint8Array(32).fill(41)]]),
      new Map([[1, new Uint8Array(32).fill(42)]]),
    );
    const verifier = await cryptography.deriveVerifier('123456', 1);
    const credentialId = cryptography.randomToken(32);
    const signature = await cryptography.signQr(credentialId, 1);
    return Response.json({
      valid: await cryptography.verifySecret('123456', verifier),
      invalid: await cryptography.verifySecret('000000', verifier),
      validQr: await cryptography.verifyQr(credentialId, 1, signature),
      tokenBytes: cryptography.randomToken(32).length,
      algorithm: verifier.algorithm,
    });
  },
};
