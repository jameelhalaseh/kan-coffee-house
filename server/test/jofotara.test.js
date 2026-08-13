// JoFotara (فوترة) — Jordan's national e-invoicing submission.
//
// NOTE ON SCOPE: server/jofotara.js says plainly that the UBL profile is UNVERIFIED —
// JoFotara has no sandbox, so only a live submission proves the XML. These tests
// deliberately do NOT assert that the XML is correct per the ISTD manual, because nothing
// here can know that. They cover what is knowable locally: credentials never leak,
// submission is idempotent, a rejection is recorded rather than thrown, and a refund goes
// out as a positive-valued credit note instead of a negative invoice.
const request = require('supertest');
const { seedUsers, login, auth, clearOrders, app, db } = require('./helpers');
const jofotara = require('../jofotara');

let adminToken;
let cashierToken;
const realFetch = global.fetch;

const CREDS = {
  JOFOTARA_CLIENT_ID: 'test-client-id',
  JOFOTARA_SECRET_KEY: 'test-secret-key',
  JOFOTARA_ACTIVITY_NUMBER: '12345',
  JOFOTARA_SELLER_TIN: '9988776',
  JOFOTARA_SELLER_NAME: 'Test Liquor Store',
};
const saved = {};

const configure = () => Object.assign(process.env, CREDS);
const unconfigure = () => { for (const k of Object.keys(CREDS)) delete process.env[k]; };

beforeAll(async () => {
  for (const k of Object.keys(CREDS)) saved[k] = process.env[k];
  await seedUsers();
  adminToken = await login('admin');
  cashierToken = await login('cashier');
});

beforeEach(async () => {
  await clearOrders();
  global.fetch = realFetch;
  unconfigure();
});

afterAll(() => {
  global.fetch = realFetch;
  for (const k of Object.keys(CREDS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return db.pool.end();
});

function stubFetch(reply) {
  const calls = [];
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return reply();
  });
  return calls;
}

const accepted = (over = {}) => () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ EINV_INV_UUID: 'istd-uuid-1', EINV_QR: 'QR-PAYLOAD', ...over }),
});

// Insert a sale straight into the table so the route has something to submit.
async function saleRow({ id = 'jo-1', total = 23.2, pay = 'cash', status = null, invoice = 7001, items } = {}) {
  await db.query(
    `insert into orders_main (id, items, sub, tax, total, pay, waiter, status, date, time, invoice_no, floor)
     values ($1,$2::jsonb,$3,0,$3,$4,'test_cashier',$5,'2026-05-01','12:00:00',$6,'main')`,
    [id, JSON.stringify(items || [{ id: 1, name: 'Arak 750ml', qty: 2, price: 10 }]), total, pay, status, invoice]
  );
  return id;
}

const send = (token, id, body = {}) =>
  request(app).post(`/api/jofotara/send/${id}`).set(...auth(token)).send(body);

describe('configuration', () => {
  test('reports unconfigured when credentials are missing', async () => {
    const res = await request(app).get('/api/jofotara/status').set(...auth(cashierToken));
    expect(res.body.configured).toBe(false);
  });

  test('reports configured once every credential is present', async () => {
    configure();
    const res = await request(app).get('/api/jofotara/status').set(...auth(adminToken));
    expect(res.body).toMatchObject({ configured: true, taxpayer_type: 'unregistered' });
  });

  test('one missing credential is still unconfigured', async () => {
    configure();
    delete process.env.JOFOTARA_SELLER_TIN;
    expect(jofotara.isConfigured()).toBe(false);
  });

  test('never exposes the secret key over HTTP', async () => {
    configure();
    const res = await request(app).get('/api/jofotara/status').set(...auth(adminToken));
    expect(JSON.stringify(res.body)).not.toContain('test-secret-key');
  });

  test('status requires a session', async () => {
    expect((await request(app).get('/api/jofotara/status')).status).toBe(401);
  });
});

describe('invoice type code', () => {
  test('cash sale by an unregistered taxpayer', () => {
    expect(jofotara.invoiceTypeCode({ pay: 'cash' }, 'unregistered')).toBe('011');
  });

  test('cash sale by a general-sales-registered taxpayer', () => {
    expect(jofotara.invoiceTypeCode({ pay: 'cash' }, 'standard')).toBe('012');
  });

  test('non-cash payment switches the terms digits to receivable', () => {
    expect(jofotara.invoiceTypeCode({ pay: 'card' }, 'standard')).toBe('022');
    // CliQ files as receivable, the same as a card. Pinned so the treatment cannot change
    // by accident — see the note on invoiceTypeCode: it is the seller's call to make, not
    // something a refactor should decide.
    expect(jofotara.invoiceTypeCode({ pay: 'cliq' }, 'standard')).toBe('022');
  });

  test('special-sales registration', () => {
    expect(jofotara.invoiceTypeCode({ pay: 'cash' }, 'special')).toBe('013');
  });
});

describe('XML building', () => {
  const cfg = () => { configure(); return jofotara.CFG(); };

  test('includes the seller identity and invoice number', () => {
    const xml = jofotara.buildInvoiceXml(
      { invoice_no: 7001, total: 20, pay: 'cash', date: '2026-05-01', items: [{ name: 'Arak', qty: 2, price: 10 }] },
      cfg()
    );
    expect(xml).toContain('7001');
    expect(xml).toContain('Test Liquor Store');
    expect(xml).toContain('9988776');
  });

  test('escapes XML metacharacters in a product name', () => {
    // A product called `Ben & Jerry's <special>` must not break the document.
    const xml = jofotara.buildInvoiceXml(
      { invoice_no: 1, total: 10, pay: 'cash', items: [{ name: `Ben & Jerry's <special>`, qty: 1, price: 10 }] },
      cfg()
    );
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;special&gt;');
    expect(xml).not.toMatch(/<special>/);
  });

  test('submits a refund as a credit note with positive figures', () => {
    // ISTD rejects negative quantities and prices outright.
    const xml = jofotara.buildInvoiceXml(
      { invoice_no: 7002, total: -20, status: 'refund', pay: 'cash',
        items: [{ name: 'Arak', qty: 2, price: 10 }], buyer: 'return of #7001' },
      cfg()
    );
    expect(xml).toContain('381');            // UBL credit-note type code
    expect(xml).not.toMatch(/>-\d/);         // no negative numeric values anywhere
  });

  test('emits plain decimals, never exponent notation', () => {
    // A tiny price is exactly where JS would produce "1e-6" and ISTD would reject the
    // document. Match element VALUES only — element names and namespace URIs legitimately
    // contain things like "Invoice-2".
    const xml = jofotara.buildInvoiceXml(
      { invoice_no: 1, total: 0.000001, pay: 'cash', items: [{ name: 'Tiny', qty: 1, price: 0.000001 }] },
      cfg()
    );
    expect(xml).not.toMatch(/>\s*-?\d+(\.\d+)?e[+-]?\d+\s*</i);
    // Monetary elements are emitted at JOD's 3 fils decimals, so a sub-fil price floors
    // to 0.000 rather than surviving as 1e-6.
    expect(xml).toMatch(/<cbc:PriceAmount currencyID="JO">0\.000</);
  });

  test('handles a sale with no line items without throwing', () => {
    expect(() => jofotara.buildInvoiceXml({ invoice_no: 1, total: 0, pay: 'cash' }, cfg())).not.toThrow();
  });
});

describe('submission', () => {
  test('is refused when the integration is not configured', async () => {
    await saleRow();
    const res = await send(adminToken, 'jo-1');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'not_configured' });
  });

  test('404s on an unknown sale', async () => {
    configure();
    stubFetch(accepted());
    expect((await send(adminToken, 'no-such-sale')).status).toBe(404);
  });

  test('rejects an unknown store', async () => {
    configure();
    await saleRow();
    expect((await send(adminToken, 'jo-1', { floor: 'nope' })).status).toBe(400);
  });

  test('stores the returned uuid and QR against the sale', async () => {
    configure();
    stubFetch(accepted());
    await saleRow();

    const res = await send(adminToken, 'jo-1');
    expect(res.body).toMatchObject({ ok: true, uuid: 'istd-uuid-1', qr: 'QR-PAYLOAD' });

    const { rows } = await db.query('select * from orders_main where id = $1', ['jo-1']);
    expect(rows[0].jofotara_status).toBe('sent');
    expect(rows[0].jofotara_uuid).toBe('istd-uuid-1');
    expect(rows[0].jofotara_sent_at).not.toBeNull();
  });

  test('sends the credentials as headers and a base64 invoice body', async () => {
    configure();
    const calls = stubFetch(accepted());
    await saleRow();
    await send(adminToken, 'jo-1');

    expect(calls[0].init.headers['Client-Id']).toBe('test-client-id');
    expect(calls[0].init.headers['Secret-Key']).toBe('test-secret-key');
    const xml = Buffer.from(calls[0].body.invoice, 'base64').toString('utf8');
    expect(xml).toContain('Invoice');
    expect(xml).toContain('7001');
  });

  test('never returns the credentials to the browser', async () => {
    configure();
    stubFetch(accepted());
    await saleRow();
    const res = await send(adminToken, 'jo-1');
    expect(JSON.stringify(res.body)).not.toContain('test-secret-key');
  });

  test('does not file the same invoice twice', async () => {
    // A double-tap on the button must not create a second filing with the authority.
    configure();
    const calls = stubFetch(accepted());
    await saleRow();

    await send(adminToken, 'jo-1');
    const second = await send(adminToken, 'jo-1');

    expect(second.body).toMatchObject({ ok: true, already: true, uuid: 'istd-uuid-1' });
    expect(calls).toHaveLength(1);
  });

  test('records an ISTD rejection against the sale instead of throwing', async () => {
    configure();
    stubFetch(() => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'TIN mismatch' }) }));
    await saleRow();

    const res = await send(adminToken, 'jo-1');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('jofotara_rejected');

    const { rows } = await db.query('select jofotara_status, jofotara_error from orders_main where id = $1', ['jo-1']);
    expect(rows[0].jofotara_status).toBe('failed');
    expect(rows[0].jofotara_error).toContain('TIN mismatch');
  });

  test('a rejected sale can be retried', async () => {
    configure();
    stubFetch(() => ({ ok: false, status: 400, text: async () => 'nope' }));
    await saleRow();
    await send(adminToken, 'jo-1');

    stubFetch(accepted());
    const res = await send(adminToken, 'jo-1');
    expect(res.body).toMatchObject({ ok: true });
  });

  test('a network failure is reported as a failure, not a success', async () => {
    configure();
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    await saleRow();

    const res = await send(adminToken, 'jo-1');
    expect(res.status).toBe(502);
    const { rows } = await db.query('select jofotara_status, jofotara_error from orders_main where id = $1', ['jo-1']);
    expect(rows[0].jofotara_status).toBe('failed');
    expect(rows[0].jofotara_error).toContain('network');
  });

  test('accepts the alternative QR field spellings ISTD has used', async () => {
    configure();
    stubFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ uuid: 'alt-uuid', qrCode: 'ALT-QR' }) }));
    await saleRow();

    const res = await send(adminToken, 'jo-1');
    expect(res.body).toMatchObject({ uuid: 'alt-uuid', qr: 'ALT-QR' });
  });

  test('a cashier holding the history view may NOT submit (12 Aug audit)', async () => {
    // This used to be allowed on the reasoning that "filing is part of finishing a sale".
    // The audit disagreed: submitting to the ISTD is an outbound legal filing on the
    // business's behalf, and the standard cashier holds `history`, so every till could file.
    // The gate is now `reports` only — admins still bypass it.
    configure();
    stubFetch(accepted());
    await saleRow();
    expect((await send(cashierToken, 'jo-1')).status).toBe(403);
  });

  test('a user with the reports view may submit', async () => {
    configure();
    stubFetch(accepted());
    await saleRow();
    expect((await send(adminToken, 'jo-1')).status).toBe(200);
  });

  test('requires a session', async () => {
    configure();
    await saleRow();
    expect((await request(app).post('/api/jofotara/send/jo-1').send({})).status).toBe(401);
  });
});

describe('pending queue', () => {
  test('lists sales not yet accepted, oldest first', async () => {
    await saleRow({ id: 'jo-old', invoice: 1, total: 10 });
    await saleRow({ id: 'jo-new', invoice: 2, total: 20 });

    const res = await request(app).get('/api/jofotara/pending').set(...auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id)).toEqual(['jo-old', 'jo-new']);
  });

  test('drops a sale once it has been accepted', async () => {
    configure();
    stubFetch(accepted());
    await saleRow();
    await send(adminToken, 'jo-1');

    expect((await request(app).get('/api/jofotara/pending').set(...auth(adminToken))).body).toEqual([]);
  });

  test('keeps a failed sale in the queue with its error', async () => {
    configure();
    stubFetch(() => ({ ok: false, status: 400, text: async () => 'TIN mismatch' }));
    await saleRow();
    await send(adminToken, 'jo-1');

    const rows = (await request(app).get('/api/jofotara/pending').set(...auth(adminToken))).body;
    expect(rows).toHaveLength(1);
    expect(rows[0].jofotara_error).toContain('TIN mismatch');
  });

  test('requires a session', async () => {
    expect((await request(app).get('/api/jofotara/pending')).status).toBe(401);
  });
});
