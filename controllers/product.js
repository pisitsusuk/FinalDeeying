// server/controllers/product.js
const prisma = require("../config/prisma");
const cloudinary = require("cloudinary").v2;

/* Cloudinary config */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
  api_key: process.env.CLOUDINARY_API_KEY || "",
  api_secret: process.env.CLOUDINARY_API_SECRET || "",
});

/* ========== Product CRUD ========== */

exports.create = async (req, res) => {
  try {
    const {
      title,
      description = "",
      price = 0,
      quantity = 0,
      categoryId,
      images = [],
    } = req.body;

    if (!title) return res.status(400).json({ ok: false, message: "กรุณาใส่ชื่อสินค้า" });

    const product = await prisma.product.create({
      data: {
        title: String(title).trim(),
        description,
        price: Number(price) || 0,
        quantity: Number(quantity) || 0,
        categoryId: categoryId ? Number(categoryId) : null,
        images: Array.isArray(images) && images.length
          ? { create: images.map((im) => ({
              asset_id: im.asset_id || "",
              public_id: im.public_id,
              url: im.url || "",
              secure_url: im.secure_url || "",
            })) }
          : undefined,
      },
      include: { images: true },
    });

    return res.json(product);
  } catch (e) {
    console.error("create product error:", e);
    return res.status(500).json({ ok: false, message: "สร้างสินค้าไม่สำเร็จ" });
  }
};

exports.listProducts = async (_req, res) => {
  try {
    const count = Number(_req.params?.count) || 20;
    const items = await prisma.product.findMany({
      take: count,
      orderBy: { updatedAt: "desc" },
      include: { images: true },
    });
    return res.json(items);
  } catch (e) {
    console.error("listProducts error:", e);
    return res.status(500).json({ ok: false, message: "ดึงรายการสินค้าไม่สำเร็จ" });
  }
};

exports.read = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: "id ไม่ถูกต้อง" });

    const item = await prisma.product.findUnique({ where: { id }, include: { images: true } });
    if (!item) return res.status(404).json({ ok: false, message: "ไม่พบสินค้า" });
    return res.json(item);
  } catch (e) {
    console.error("read product error:", e);
    return res.status(500).json({ ok: false, message: "ดึงข้อมูลสินค้าไม่สำเร็จ" });
  }
};

exports.update = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: "id ไม่ถูกต้อง" });

    const { images = [], ...rest } = req.body;

    const product = await prisma.product.update({
      where: { id },
      data: {
        title: typeof rest.title === "string" ? rest.title.trim() : undefined,
        description: typeof rest.description === "string" ? rest.description : undefined,
        price: typeof rest.price !== "undefined" ? (Number(rest.price) || 0) : undefined,
        quantity: typeof rest.quantity !== "undefined" ? (Number(rest.quantity) || 0) : undefined,
        categoryId:
          typeof rest.categoryId !== "undefined"
            ? (rest.categoryId ? Number(rest.categoryId) : null)
            : undefined,
        images: Array.isArray(images)
          ? {
              deleteMany: {},
              create: images.map((im) => ({
                asset_id: im.asset_id || "",
                public_id: im.public_id,
                url: im.url || "",
                secure_url: im.secure_url || "",
              })),
            }
          : undefined,
      },
      include: { images: true },
    });

    return res.json(product);
  } catch (e) {
    console.error("update product error:", e);
    return res.status(500).json({ ok: false, message: "อัปเดตสินค้าไม่สำเร็จ" });
  }
};

/* -------------------- Helpers สำหรับตรวจการใช้งานสินค้า -------------------- */

/** นับจำนวน “สลิปที่ยังมีอยู่จริงในตาราง payment_slips” ที่มีสินค้านี้
 *  - นับเฉพาะสลิปสถานะ PENDING/APPROVED (รายการที่มีผลต่อการขาย)
 *  - ไม่สนใจ snapshot ที่ถูกทิ้งไว้ลอย ๆ ใน payment_slip_items
 */
async function countProductInSlips(productId) {
  // Postgres
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS c
      FROM payment_slip_items psi
      JOIN payment_slips ps ON ps.id = psi.slip_id
      WHERE psi.product_id = ${productId}
        AND ps.status IN ('PENDING','APPROVED')
    `;
    const c = Number(rows?.[0]?.c || 0);
    if (c > 0) return c;
  } catch {}

  // MySQL
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS c
      FROM payment_slip_items psi
      JOIN payment_slips ps ON ps.id = psi.slip_id
      WHERE psi.product_id = ${productId}
        AND ps.status IN ('PENDING','APPROVED')
    `;
    const c = Number(rows?.[0]?.c || 0);
    if (c > 0) return c;
  } catch {}

  return 0;
}

// helper: นับจำนวนออเดอร์ที่มีสินค้านี้ (กันพลาดจากฝั่ง Order ด้วย)
async function countProductUsedInOrders(id) {
  // 1) ผ่าน relation ปกติของ Prisma
  try {
    const c1 = await prisma.productOnOrder.count({ where: { productId: id } });
    if (c1 > 0) return c1;
  } catch {}

  // 2) Raw (Postgres) — "ProductOnOrder"
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS c FROM "ProductOnOrder" WHERE "productId" = ${id}
    `;
    const c = Number(rows?.[0]?.c || 0);
    if (c > 0) return c;
  } catch {}

  // 3) Raw (MySQL) — ProductOnOrder
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS c FROM ProductOnOrder WHERE productId = ${id}
    `;
    const c = Number(rows?.[0]?.c || 0);
    if (c > 0) return c;
  } catch {}

  // 4) ไล่นับผ่าน Order->products (ถ้า schema รองรับ)
  try {
    const c4 = await prisma.order.count({
      where: { products: { some: { productId: id } } },
    });
    return c4 || 0;
  } catch {}

  return 0;
}

exports.remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "id ไม่ถูกต้อง" });
    }

    // ❗ อนุญาตให้ลบได้เมื่อ “หน้า Approve ไม่มีรายการที่มีสินค้านี้”
    //    = ไม่มีสลิป PENDING/APPROVED ที่ยังอยู่ในระบบอ้างอิงสินค้านี้
    const inSlip = await countProductInSlips(id);
    if (inSlip > 0) {
      return res.status(409).json({
        ok: false,
        code: "PRODUCT_IN_SLIPS",
        message: `ลบสินค้าไม่ได้ เนื่องจากสินค้านี้อยู่ในสลิปที่ยังมีอยู่ ${inSlip} ใบ`,
        count: inSlip,
      });
    }

    // กันลบถ้ามีอยู่ใน “ออเดอร์” จริง ๆ (ปลอดภัยไว้ก่อน)
    const usedCount = await countProductUsedInOrders(id);
    if (usedCount > 0) {
      return res.status(409).json({
        ok: false,
        code: "PRODUCT_IN_ORDERS",
        message: `ลบสินค้าไม่ได้ เนื่องจากยังมีสินค้านี้อยู่ในคำสั่งซื้อ `,
        count: usedCount,
      });
    }

    await prisma.product.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (e) {
    if (e?.code === "P2025") {
      return res.status(404).json({ ok: false, message: "ไม่พบสินค้า" });
    }
    console.error("remove product error:", e);
    return res.status(500).json({ ok: false, message: "ลบสินค้าไม่สำเร็จ" });
  }
};



/* ========== Images (Cloudinary) ========== */
// รองรับทั้ง multipart (req.file / req.files[0]) และ dataURL (req.body.image)
exports.uploadImages = async (req, res) => {
  try {
    const MAX_BYTES = 5 * 1024 * 1024;
    const ALLOW_MIME = new Set(["image/png","image/jpeg","image/webp","image/heic","image/heif","image/gif"]);

    console.log("uploadImages start:", {
      ct: req.headers["content-type"],
      hasFile: !!req.file,
      filesLen: Array.isArray(req.files) ? req.files.length : 0,
      bodyKeys: Object.keys(req.body || {}),
    });

    // 1) multipart
    const f = req.file || (Array.isArray(req.files) && req.files.find(Boolean));
    if (f && f.buffer) {
      if (Number(f.size) > MAX_BYTES) return res.status(400).json({ ok:false, message:"ไฟล์ใหญ่เกิน 5MB" });
      if (f.mimetype && !ALLOW_MIME.has(f.mimetype)) console.warn("⚠️ Unusual mimetype:", f.mimetype);

      const streamUpload = () =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "deeying/products", resource_type: "image" },
            (err, result) => (err ? reject(err) : resolve(result))
          );
          stream.end(f.buffer);
        });

      const up = await streamUpload();
      return res.json({
        ok: true,
        asset_id: up.asset_id,
        public_id: up.public_id,
        url: up.secure_url || up.url,
        secure_url: up.secure_url || up.url,
        width: up.width,
        height: up.height,
        format: up.format,
        bytes: up.bytes,
      });
    }

    // 2) dataURL base64
    const dataUrl = req.body?.image;
    if (typeof dataUrl === "string") {
      const isDataUrl = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(dataUrl);
      if (!isDataUrl) return res.status(400).json({ ok:false, message:"รูปแบบ image ต้องเป็น dataURL base64" });

      const up = await cloudinary.uploader.upload(dataUrl, {
        folder: "deeying/products",
        resource_type: "image",
      });
      return res.json({
        ok: true,
        asset_id: up.asset_id,
        public_id: up.public_id,
        url: up.secure_url || up.url,
        secure_url: up.secure_url || up.url,
        width: up.width,
        height: up.height,
        format: up.format,
        bytes: up.bytes,
      });
    }

    const isMultipart = (req.headers["content-type"] || "").includes("multipart/form-data");
    return res.status(400).json({
      ok: false,
      message: isMultipart
        ? "ไม่พบไฟล์ในฟอร์ม (ตรวจ field name ให้เป็น 'image' หรือใช้ upload.any())"
        : "No image found (multipart หรือ dataURL)",
    });
  } catch (e) {
    console.error("uploadImages error:", e?.response?.body || e);
    return res.status(500).json({ ok:false, message:"Upload failed" });
  }
};

// server/controllers/product.js
exports.removeImages = async (req, res) => {
  try {
    let publicId = (req.body?.public_id || "").toString().trim();
    if (!publicId) return res.status(400).json({ ok:false, message:"missing public_id" });

    // เผื่อเผลอส่ง URL มา -> แปลงเป็น public_id ให้เอง
    // ตัวอย่าง URL: https://res.cloudinary.com/<cloud>/image/upload/v1725700000/deeying/products/abc123.jpg
    if (/^https?:\/\//i.test(publicId)) {
      const m = publicId.match(/\/upload\/(?:v\d+\/)?([^?#.]+)(?:\.[a-z0-9]+)?/i);
      if (m && m[1]) publicId = m[1];  // => deeying/products/abc123
    }

    // ลบรูป + เคลียร์ CDN cache
    const del = await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
      type: "upload",
      invalidate: true,
    });

    // Cloudinary มักส่ง { result: "ok" } หรือ "not found"
    // บางเคสอาจเป็น "deleted" หรือค่าที่ต่าง account/plan
    const okResults = new Set(["ok", "not found", "deleted"]);
    if (okResults.has((del?.result || "").toLowerCase())) {
      return res.json({ ok: true, result: del.result || "ok" });
    }

    // ถ้าถึงตรงนี้ แปลว่าคำตอบไม่ใช่ ok/not_found/deleted
    return res.status(500).json({
      ok: false,
      message: "Cloudinary destroy failed",
      detail: del,
    });
  } catch (e) {
    console.error("removeImages error:", e);
    return res.status(500).json({ ok:false, message:"Delete failed" });
  }
};


/* ========== Search / ListBy ========== */

exports.searchFilters = async (req, res) => {
  try {
    console.log("searchFilters payload:", req.body);

    const { query, categoryIds, category, minPrice, maxPrice, price } = req.body || {};
    const q = typeof query === "string" ? query.trim() : "";
    const catRaw = Array.isArray(categoryIds) ? categoryIds : Array.isArray(category) ? category : [];
    const catIds = catRaw.map((x) => Number(x)).filter(Number.isFinite);

    let pmin, pmax;
    if (Array.isArray(price) && price.length === 2) {
      pmin = Number(price[0]); pmax = Number(price[1]);
    } else {
      pmin = Number(minPrice); pmax = Number(maxPrice);
    }
    if (!Number.isFinite(pmin)) pmin = undefined;
    if (!Number.isFinite(pmax)) pmax = undefined;

    const where = {};
    if (q) where.title = { contains: q };
    if (catIds.length) where.categoryId = { in: catIds };
    if (pmin != null || pmax != null) {
      where.price = {};
      if (pmin != null) where.price.gte = pmin;
      if (pmax != null) where.price.lte = pmax;
    }

    let items = await prisma.product.findMany({
      where,
      orderBy: { id: "desc" },
      include: { images: true },
    });

    if (q) {
      const qLower = q.toLowerCase();
      items = items.filter((it) => String(it.title || "").toLowerCase().includes(qLower));
    }

    console.log("searchFilters where:", where, "-> items:", items.length);
    return res.json({ items });
  } catch (err) {
    console.error("searchFilters error:", err);
    return res.status(500).json({ ok:false, message:"Server error (searchFilters)" });
  }
};

exports.listProductBy = async (req, res) => {
  try {
    const { sort = "createdAt", order = "desc", limit = 12 } = req.body || {};
    const items = await prisma.product.findMany({
      take: Number(limit) || 12,
      orderBy: { [sort]: order.toLowerCase() === "asc" ? "asc" : "desc" },
      include: { images: true },
    });
    return res.json(items);
  } catch (e) {
    console.error("listProductBy error:", e);
    return res.status(500).json({ ok:false, message:"ดึงสินค้าจัดเรียงไม่สำเร็จ" });
  }
};
