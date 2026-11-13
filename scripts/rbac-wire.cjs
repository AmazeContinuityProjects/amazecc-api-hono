const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '..', 'src', 'routes');

// file -> permission key (or 'SUPERADMIN' for superadmin-only routes)
const map = {
  'admin/stats.ts': 'dashboard',
  'admin/buses.ts': 'buses',
  'admin/cabshare-hubs.ts': 'cabshare',
  'admin/cabshare-trips.ts': 'cabshare',
  'admin/clubs.ts': 'clubs',
  'admin/clubs-representatives.ts': 'clubs',
  'admin/faculty-directories.ts': 'faculty-directories',
  'admin/fresher-resources.ts': 'fresher-resources',
  'admin/fresher-resources-id.ts': 'fresher-resources',
  'admin/gorobo-analytics.ts': 'gorobo',
  'admin/gorobo-bundles.ts': 'gorobo',
  'admin/gorobo-bundles-id.ts': 'gorobo',
  'admin/gorobo-items.ts': 'gorobo',
  'admin/gorobo-items-id.ts': 'gorobo',
  'admin/gorobo-items-stock.ts': 'gorobo',
  'admin/gorobo-orders.ts': 'gorobo',
  'admin/gorobo-orders-id.ts': 'gorobo',
  'admin/gorobo-orders-archive.ts': 'gorobo',
  'admin/gorobo-orders-complete.ts': 'gorobo',
  'admin/gorobo-orders-confirm.ts': 'gorobo',
  'admin/gorobo-orders-unarchive.ts': 'gorobo',
  'admin/gorobo-wallet.ts': 'gorobo',
  'admin/gorobo-wallet-settle.ts': 'gorobo',
  'admin/ocr.ts': 'ocr',
  'admin/ocr-reset.ts': 'ocr',
  'admin/push.ts': 'push',
  'admin/settings-global.ts': 'settings',
  'admin/storage.ts': 'storage',
  'admin/transport-placements.ts': 'transport',
  'admin/transport-routes.ts': 'transport',
  'admin/transport-routes-id.ts': 'transport',
  'admin/transport-routes-id-stops.ts': 'transport',
  'admin/transport-rules.ts': 'transport',
  'admin/transport-rules-id.ts': 'transport',
  'admin/transport-seed.ts': 'transport',
  'admin/transport-students.ts': 'transport',
  'admin/migrate.ts': 'SUPERADMIN',
  'admin/users.ts': 'SUPERADMIN',
  'admin/users-username.ts': 'SUPERADMIN',
  'qbank/questions.ts': 'qbank',
  'qbank/bulk.ts': 'qbank',
  'qbank/queue.ts': 'qbank',
  'qbank/ocr.ts': 'qbank',
  'qbank/publish.ts': 'qbank',
  'qbank/reject.ts': 'qbank',
  'qbank/import-to-storage.ts': 'qbank',
};

let changed = [];
for (const [rel, perm] of Object.entries(map)) {
  const file = path.join(routesDir, rel);
  if (!fs.existsSync(file)) { console.log('MISSING', rel); continue; }
  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  if (s.includes('requireAdminAuth')) {
    // rewrite requireAdminAuth(req) -> requireSection("key")(req) or requireSuperadmin(req)
    if (perm === 'SUPERADMIN') {
      s = s.replace(/requireAdminAuth\(req\)/g, 'requireSuperadmin(req)');
    } else {
      s = s.replace(/requireAdminAuth\(req\)/g, `requireSection('${perm}')(req)`);
    }

    // rewrite the import to pull in the new helper
    s = s.replace(/import\s*\{[^}]*requireAdminAuth[^}]*\}\s*from\s*(['"])([^'"]+)\1/, (m, q, from) => {
      if (perm === 'SUPERADMIN') {
        return `import { requireSuperadmin } from${q}${from}${q}`;
      }
      // preserve other named imports if any
      const named = m.match(/\{([^}]*)\}/)[1]
        .split(',').map(x => x.trim()).filter(x => x && x !== 'requireAdminAuth');
      return `import { ${named.length ? named.join(', ') + ', ' : ''}requireSection } from${q}${from}${q}`;
    });
  }

  if (s !== before) { fs.writeFileSync(file, s); changed.push(rel); }
}
console.log('changed', changed.length, 'files');
