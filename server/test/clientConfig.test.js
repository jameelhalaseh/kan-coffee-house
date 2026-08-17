// Runtime client config — the thing that lets one image serve every shop.
//
// Two classes of failure are covered here. The first is drift: the server decides which
// views a shop may show, the bundle decides which views exist, and a view the server offers
// that the bundle cannot render is a nav tab leading to a blank screen. The second is
// silence: a mistyped VAT rate that falls back to 16% prints a wrong tax line on every
// receipt that shop ever issues, and nothing in the app ever says so.
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const CONFIG = path.join(__dirname, '..', '..', 'src', 'client.config.js');

// Reload the module with a fresh environment. clientConfig() reads process.env at call
// time, but requiring it fresh keeps each case independent of the last.
function load(env = {}) {
  const saved = { ...process.env };
  // `undefined` means UNSET, not the string "undefined" — which is what Object.assign would
  // produce, and which every one of these vars would then read as a deliberate value.
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  jest.resetModules();
  const mod = require('../clientConfig');
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
  return { mod, restore };
}

function withEnv(env, fn) {
  const { mod, restore } = load(env);
  try { return fn(mod); } finally { restore(); }
}

describe('client config — defaults', () => {
  test('an unset environment reproduces the Kan Coffee House build', () => {
    // The guarantee that keeps a misconfigured deploy honest: a stack that sets none of the
    // CLIENT_* vars still identifies as THIS shop, not as the template it was forked from.
    withEnv({ CLIENT_STORE_NAME: undefined }, ({ clientConfig }) => {
      const c = clientConfig();
      expect(c.storeName).toBe('Kan Coffee House');
      expect(c.currency).toBe('JOD');
      expect(c.store.taxPct).toBe(16);
      expect(c.bill.invoicePrefix).toBe('KC');
      expect(c.bill.legalNote).toBe('');
      // The point of the fork's change, pinned so nobody "restores" the placeholder: an
      // unset tax number must be EMPTY, never the template's '1234567'. A fake registration
      // printed on every receipt is not a default, it is a liability.
      expect(c.bill.seller.taxNo).toBe('');
    });
  });

  test('the store key is fixed to the server registry and cannot be set by env', () => {
    // It names the physical orders_<key> table. An env-settable key would let a shop point
    // its till at a table no migration created, and every checkout would 400.
    withEnv({ CLIENT_STORE_KEY: 'shop2' }, ({ clientConfig }) => {
      expect(clientConfig().store.key).toBe('main');
    });
  });

  test('the timezone comes from the server clock, so the two cannot disagree', () => {
    withEnv({ STORE_TZ: 'Europe/Berlin' }, ({ clientConfig }) => {
      expect(clientConfig().store.timezone).toBe('Europe/Berlin');
    });
  });

  test('a blank value is treated as unset, not as an empty shop name', () => {
    withEnv({ CLIENT_STORE_NAME: '   ' }, ({ clientConfig }) => {
      expect(clientConfig().storeName).toBe('Kan Coffee House');
    });
  });

  test('the seller name defaults to the store name rather than to the shipped literal', () => {
    withEnv({ CLIENT_STORE_NAME: 'Bawabet Amman' }, ({ clientConfig }) => {
      expect(clientConfig().bill.seller.name).toBe('Bawabet Amman');
    });
  });
});

describe('client config — a real second client', () => {
  test('every identity field is overridden from the environment', () => {
    withEnv({
      CLIENT_STORE_NAME: 'Dukkan Al Balad',
      CLIENT_CURRENCY: 'JOD',
      CLIENT_LANG: 'ar',
      CLIENT_TAX_PCT: '0',
      CLIENT_INVOICE_PREFIX: 'DK',
      CLIENT_SELLER_LOCATION: 'Irbid, Jordan',
      CLIENT_SELLER_TAX_NO: '9988776',
      CLIENT_LEGAL_NOTE: 'صدرت هذه الفاتورة وفق أحكام المادة 5',
    }, ({ clientConfig }) => {
      const c = clientConfig();
      expect(c.storeName).toBe('Dukkan Al Balad');
      expect(c.locale.default).toBe('ar');
      expect(c.store.taxPct).toBe(0);
      expect(c.bill.invoicePrefix).toBe('DK');
      expect(c.bill.seller.location).toBe('Irbid, Jordan');
      expect(c.bill.legalNote).toContain('المادة 5');
    });
  });

  test('a zero tax rate survives — a tax-free shop is not a missing value', () => {
    withEnv({ CLIENT_TAX_PCT: '0' }, ({ clientConfig }) => {
      expect(clientConfig().store.taxPct).toBe(0);
    });
  });
});

describe('client config — refuses to start on a bad store identity', () => {
  // Each of these prints wrong money or a wrong name on real receipts. Falling back to a
  // default would be silent; refusing to boot shows up immediately in the restart loop.
  test('a non-numeric tax rate throws', () => {
    withEnv({ CLIENT_TAX_PCT: 'sixteen' }, ({ clientConfig }) => {
      expect(() => clientConfig()).toThrow(/CLIENT_TAX_PCT/);
    });
  });

  test('an out-of-range tax rate throws', () => {
    withEnv({ CLIENT_TAX_PCT: '160' }, ({ clientConfig }) => {
      expect(() => clientConfig()).toThrow(/between 0 and 100/);
    });
  });

  test('an unsupported language throws', () => {
    withEnv({ CLIENT_LANG: 'fr' }, ({ clientConfig }) => {
      expect(() => clientConfig()).toThrow(/CLIENT_LANG/);
    });
  });

  test('an unknown view throws', () => {
    withEnv({ CLIENT_VIEWS: 'sales,tables' }, ({ clientConfig }) => {
      expect(() => clientConfig()).toThrow(/CLIENT_VIEWS/);
    });
  });

  test('a view list with no sales screen throws', () => {
    withEnv({ CLIENT_VIEWS: 'reports,settings' }, ({ clientConfig }) => {
      expect(() => clientConfig()).toThrow(/cannot sell/);
    });
  });
});

describe('client config — views', () => {
  test('the assistant is hidden when there is no AI key to talk to', () => {
    withEnv({ NVIDIA_API_KEY: undefined }, ({ clientConfig }) => {
      expect(clientConfig().views).not.toContain('assistant');
      expect(clientConfig().views).toContain('sales');
    });
  });

  test('the assistant appears once a key is configured', () => {
    withEnv({ NVIDIA_API_KEY: 'nvapi-test' }, ({ clientConfig }) => {
      expect(clientConfig().views).toContain('assistant');
    });
  });

  test('an explicit list wins over the AI-key default', () => {
    withEnv({ CLIENT_VIEWS: 'sales,history', NVIDIA_API_KEY: 'nvapi-test' }, ({ clientConfig }) => {
      expect(clientConfig().views).toEqual(['sales', 'history']);
    });
  });
});

describe('client config — the server and the bundle agree on the view list', () => {
  // Same guarantee, and same technique, as reporting/test/payments.test.js: the two lists
  // live either side of a module-system boundary and cannot import each other, so a test
  // pins them instead of hope.
  function bundleViews() {
    const src = fs.readFileSync(CONFIG, 'utf8');
    const m = src.match(/export const ALL_VIEWS = \[([\s\S]*?)\];/);
    if (!m) throw new Error('ALL_VIEWS array not found in src/client.config.js');
    return Array.from(m[1].matchAll(/"([a-z]+)"/g)).map((x) => x[1]);
  }

  test('KNOWN_VIEWS matches ALL_VIEWS exactly, in the same order', () => {
    const { KNOWN_VIEWS } = require('../clientConfig');
    expect(KNOWN_VIEWS).toEqual(bundleViews());
  });
});

describe('GET /client-config.js', () => {
  test('serves executable JS that assigns window.__CLIENT__', async () => {
    const app = require('../index');
    const res = await request(app).get('/client-config.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toMatch(/^window\.__CLIENT__=\{/);

    // It has to be real JS, not just a string that looks right — this is the whole boot
    // path for every shop.
    const sandbox = { window: {} };
    // eslint-disable-next-line no-new-func
    new Function('window', res.text)(sandbox.window);
    expect(sandbox.window.__CLIENT__.storeName).toBeTruthy();
    expect(sandbox.window.__CLIENT__.store.key).toBe('main');
  });

  test('is never cached — a corrected VAT rate must not be overruled by a stale copy', async () => {
    const app = require('../index');
    const res = await request(app).get('/client-config.js');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  test('escapes < so the payload stays inert if it is ever inlined into HTML', async () => {
    const saved = process.env.CLIENT_STORE_NAME;
    process.env.CLIENT_STORE_NAME = 'Bad</script><script>alert(1)</script>';
    jest.resetModules();
    const app = require('../index');
    const res = await request(app).get('/client-config.js');
    expect(res.text).not.toContain('</script>');
    expect(res.text).toContain('\\u003c');
    if (saved === undefined) delete process.env.CLIENT_STORE_NAME; else process.env.CLIENT_STORE_NAME = saved;
    jest.resetModules();
  });
});

describe('health endpoints', () => {
  // The two must not converge. If /healthz ever starts checking the database, Docker's
  // HEALTHCHECK begins restarting the container over a dependency it cannot fix; if /readyz
  // ever stops checking it, monitoring goes green during an outage.
  test('/healthz is liveness only — it answers without touching the database', async () => {
    const app = require('../index');
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('/readyz reports ready when the database answers', async () => {
    const app = require('../index');
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  test('/readyz is 503 when the database does not answer, and leaks nothing', async () => {
    jest.resetModules();
    // Stand in for an unreachable database. A rejected query is the honest simulation: the
    // pool is what fails first when Postgres is down.
    jest.doMock('../db', () => ({
      query: jest.fn(),
      pool: { query: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')) },
    }));
    const app = require('../index');
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', error: 'database' });
    // The host and port of the database are not the caller's business — this endpoint takes
    // no authentication.
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|5432/);
    jest.dontMock('../db');
    jest.resetModules();
  });

  test('/readyz is never cached — a stale 200 would mask an outage', async () => {
    const app = require('../index');
    const res = await request(app).get('/readyz');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });
});

describe('GET /manifest.json', () => {
  test('names the installed PWA after this shop, not after the template', async () => {
    const saved = process.env.CLIENT_STORE_NAME;
    process.env.CLIENT_STORE_NAME = 'Dukkan Al Balad';
    jest.resetModules();
    const app = require('../index');
    const res = await request(app).get('/manifest.json');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Dukkan Al Balad POS');
    expect(res.body.short_name).toBe('Dukkan Al Balad');
    if (saved === undefined) delete process.env.CLIENT_STORE_NAME; else process.env.CLIENT_STORE_NAME = saved;
    jest.resetModules();
  });
});
