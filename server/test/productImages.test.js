// /api/product-images — per-product artwork (migration 0012).
//
// Sibling of categoryImages.test.js and for the same reason: the browser normalises every
// upload, but the endpoint is reachable with a session and a curl command, and whatever it
// accepts is later served back to every till as an image. What is pinned here is the part
// that differs from the category route — the key is a product id that has to exist, and the
// image must die with its product.
const request = require('supertest');
const { seedUsers, login, auth, makeProduct, clearCatalogue, app, db } = require('./helpers');

let adminToken;
let cashierToken;

beforeAll(async () => {
  await seedUsers();
  adminToken = await login('admin');
  cashierToken = await login('cashier');
});

beforeEach(async () => {
  await db.query('delete from product_images');
  await clearCatalogue();
});
afterAll(() => db.pool.end());

// A real PNG header of the given dimensions: signature + IHDR. Enough for the header
// validation under test without pulling in an image library. Same helper as the category
// suite, deliberately duplicated rather than shared — a test fixture that two suites both
// edit is a test fixture that breaks both at once.
function png(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 6;          // 8-bit RGBA
  return Buffer.concat([sig, ihdr, Buffer.alloc(64)]);
}

const put = (token, id, data) =>
  request(app).put(`/api/product-images/${id}`).set(...auth(token)).send({ data });
const get = (token, id) => request(app).get(`/api/product-images/${id}`).set(...auth(token));
const del = (token, id) => request(app).delete(`/api/product-images/${id}`).set(...auth(token));
const list = (token) => request(app).get('/api/product-images').set(...auth(token));

describe('uploading', () => {
  test('stores a valid 512x512 PNG and serves it back as an image', async () => {
    const p = await makeProduct({ name: 'Espresso', cat: 'Hot Coffee' });
    const res = await put(adminToken, p.id, png(512, 512).toString('base64'));
    expect(res.status).toBe(200);
    expect(res.body.product_id).toBe(p.id);

    const img = await get(adminToken, p.id);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/png/);
  });

  test('accepts a full data: URL, so the client can send canvas.toDataURL unchanged', async () => {
    const p = await makeProduct();
    const dataUrl = `data:image/png;base64,${png(512, 512).toString('base64')}`;
    expect((await put(adminToken, p.id, dataUrl)).status).toBe(200);
  });

  test('replacing an image keeps one row, not two', async () => {
    const p = await makeProduct();
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    const { rows } = await db.query('select count(*)::int c from product_images where product_id = $1', [p.id]);
    expect(rows[0].c).toBe(1);
  });

  test('records who uploaded it — an unattributable image on a till is not acceptable', async () => {
    const p = await makeProduct();
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    const { rows } = await db.query('select updated_by from product_images where product_id = $1', [p.id]);
    expect(rows[0].updated_by).toBe('test_admin');
  });
});

describe('rejecting what is not a 512x512 PNG', () => {
  test('a JPEG-ish blob is refused', async () => {
    const p = await makeProduct();
    const res = await put(adminToken, p.id, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not_png');
  });

  test('a wrongly-sized PNG is refused — the header is believed only after it is checked', async () => {
    const p = await makeProduct();
    const res = await put(adminToken, p.id, png(1024, 1024).toString('base64'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_size');
  });

  test('an empty payload is a 400, not a stored zero-byte image', async () => {
    const p = await makeProduct();
    expect((await put(adminToken, p.id, '')).status).toBe(400);
  });
});

describe('the product has to exist', () => {
  test('uploading for a missing id is a 404, not a foreign-key 500', async () => {
    const res = await put(adminToken, 987654321, png(512, 512).toString('base64'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  test('a non-numeric id is a 400 rather than a Postgres cast error', async () => {
    const res = await put(adminToken, 'not-an-id', png(512, 512).toString('base64'));
    expect(res.status).toBe(400);
  });

  test('deleting the product deletes its image — no orphan bytes in the backup', async () => {
    const p = await makeProduct();
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    await db.query('delete from products where id = $1', [p.id]);
    const { rows } = await db.query('select count(*)::int c from product_images where product_id = $1', [p.id]);
    expect(rows[0].c).toBe(0);
  });
});

describe('permissions', () => {
  test('a non-admin cannot upload — the tile decides what gets rung up', async () => {
    const p = await makeProduct();
    const res = await put(cashierToken, p.id, png(512, 512).toString('base64'));
    expect(res.status).toBe(403);
  });

  test('a non-admin cannot delete either', async () => {
    const p = await makeProduct();
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    expect((await del(cashierToken, p.id)).status).toBe(403);
  });

  test('a non-admin CAN read — every till has to draw the picture', async () => {
    const p = await makeProduct();
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    expect((await get(cashierToken, p.id)).status).toBe(200);
    expect((await list(cashierToken)).status).toBe(200);
  });

  test('no token reads nothing', async () => {
    const p = await makeProduct();
    expect((await request(app).get(`/api/product-images/${p.id}`)).status).toBe(401);
    expect((await request(app).get('/api/product-images')).status).toBe(401);
  });
});

describe('the manifest and caching', () => {
  test('lists only products that actually have artwork', async () => {
    const withArt = await makeProduct({ name: 'Latte' });
    await makeProduct({ name: 'Cortado' });
    await put(adminToken, withArt.id, png(512, 512).toString('base64'));

    const res = await list(adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].product_id).toBe(withArt.id);
  });

  test('a missing image is a 404, so the client falls back rather than hanging', async () => {
    const p = await makeProduct();
    expect((await get(adminToken, p.id)).status).toBe(404);
  });

  test('serves an ETag and honours If-None-Match with a 304', async () => {
    const p = await makeProduct();
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    const first = await get(adminToken, p.id);
    expect(first.headers.etag).toBeTruthy();
    expect(first.headers['cache-control']).toMatch(/immutable/);

    const second = await request(app).get(`/api/product-images/${p.id}`)
      .set(...auth(adminToken)).set('If-None-Match', first.headers.etag);
    expect(second.status).toBe(304);
  });

  test('the ETag changes when the image does, so a replacement is not served from cache', async () => {
    const p = await makeProduct();
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    const before = (await get(adminToken, p.id)).headers.etag;
    // updated_at drives the tag; wait past the clock's resolution rather than assuming it.
    await new Promise((r) => setTimeout(r, 20));
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    const after = (await get(adminToken, p.id)).headers.etag;
    expect(after).not.toBe(before);
  });
});

describe('removing', () => {
  test('delete leaves the product intact and the manifest empty', async () => {
    const p = await makeProduct({ name: 'Flat White' });
    await put(adminToken, p.id, png(512, 512).toString('base64'));
    expect((await del(adminToken, p.id)).status).toBe(200);

    expect((await list(adminToken)).body).toHaveLength(0);
    const { rows } = await db.query('select name from products where id = $1', [p.id]);
    expect(rows[0].name).toBe('Flat White');
  });

  test('deleting an image that is not there succeeds — idempotent, like logout', async () => {
    const p = await makeProduct();
    expect((await del(adminToken, p.id)).status).toBe(200);
  });
});
