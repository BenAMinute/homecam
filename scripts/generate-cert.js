const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

function ensureCertificates(certsDir) {
  const certPath = path.join(certsDir, 'cert.pem');
  const keyPath = path.join(certsDir, 'key.pem');

  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
  }

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log('✅ Custom SSL certificates found in:', certsDir);
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    };
  }

  console.log('🔐 Generating self-signed SSL certificate for LAN & HTTPS support...');

  const attrs = [{ name: 'commonName', value: 'HomeCam LAN Server' }];
  const pwaPems = selfsigned.generate(attrs, {
    algorithm: 'sha256',
    days: 3650, // 10 years
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true
      },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '0.0.0.0' }
        ]
      }
    ]
  });

  fs.writeFileSync(certPath, pwaPems.cert);
  fs.writeFileSync(keyPath, pwaPems.private);

  console.log('✅ Generated self-signed certificates at:', certsDir);
  return {
    cert: pwaPems.cert,
    key: pwaPems.private
  };
}

if (require.main === module) {
  const certsDir = process.env.CERTS_PATH || path.join(__dirname, '../certs');
  ensureCertificates(certsDir);
}

module.exports = { ensureCertificates };
