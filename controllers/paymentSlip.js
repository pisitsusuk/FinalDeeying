// controllers/paymentSlip.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/**
 * POST /api/payments/slip
 * ต้องแนบไฟล์ field="slip"
 * body: cart_id, amount, (optional) shipping_address
 */
exports.uploadSlip = async (req, res) => {
  try {
    const userId = req.user?.id; // จาก auth middleware
    if (!userId) return res.status(401).json({ ok: false, message: "unauthorized" });

    const { cart_id, amount, shipping_address } = req.body || {};

    if (!req.file)  return res.status(400).json({ ok: false, message: "missing slip file" });
    if (!cart_id)   return res.status(400).json({ ok: false, message: "missing cart_id" });
    if (!amount)    return res.status(400).json({ ok: false, message: "missing amount" });

    // path ที่เก็บลง DB (ฟรอนต์ต่อ BASE_URL เอง)
    const slipPath = "/uploads/slips/" + req.file.filename;

    // ถ้าไม่ได้ส่งที่อยู่มา ลองดึงจาก CartAddress ตาม schema ของคุณ
    let resolvedAddress = shipping_address ?? null;
    if (!resolvedAddress) {
      const addr = await prisma.cartAddress.findUnique({
        where: { cartId: Number(cart_id) },
      });
      if (addr?.address) resolvedAddress = addr.address;
    }

    // 1) บันทึกสลิป
    const slip = await prisma.paymentSlip.create({
      data: {
        cart_id: Number(cart_id),
        user_id: Number(userId),
        amount: amount.toString(),       // Decimal(10,2) → ส่ง string ชัวร์สุด
        slip_path: slipPath,
        shipping_address: resolvedAddress ?? null,
        // status default = PENDING ตาม schema
      },
    });

    // 2) SNAPSHOT รายการสินค้าในตะกร้าขณะอัปสลิป → payment_slip_items
    //    - ใช้ $queryRaw เพื่อดึงรายการจาก ProductOnCart + Product
    //    - แล้ว createMany ลง payment_slip_items
    try {
      const cartIdNum = Number(cart_id);

      const items = await prisma.$queryRaw`
        SELECT
          poc."productId"                                  AS product_id,
          p.title                                          AS title,
          COALESCE(poc.price, p.price, 0)::text            AS price_text, -- ส่งเป็น text ปลอดภัยกับ Decimal
          COALESCE(poc.count, 1)                           AS qty
        FROM "ProductOnCart" poc
        JOIN "Product" p ON p.id = poc."productId"
        WHERE poc."cartId" = ${cartIdNum}
      `;

      if (Array.isArray(items) && items.length) {
        await prisma.paymentSlipItem.createMany({
          data: items.map((it) => ({
            slip_id:    slip.id,
            product_id: Number(it.product_id) || null,
            title:      String(it.title ?? ""),
            price:      String(it.price_text ?? "0"),  // เก็บเป็น string ให้ Prisma Decimal ไม่เพี้ยน
            qty:        Number(it.qty ?? 0),
          })),
          skipDuplicates: true,
        });
      }
    } catch (snapErr) {
      // ไม่ให้ล้มทั้ง request — เก็บ log ไว้พอ
      console.error("snapshot payment_slip_items failed:", snapErr);
    }

    return res.json({ ok: true, slip });
  } catch (err) {
    console.error("upload slip error:", err);
    return res.status(500).json({ ok: false, message: err.message || "server error" });
  }
};


/** ====== ฟังก์ชันฝั่งแอดมิน (ใช้ใน routes/slipAdmin.js) ====== */

// GET /api/admin/slips?status=PENDING|APPROVED|REJECTED
exports.adminListSlips = async (req, res) => {
  try {
    const { status } = req.query || {};
    const where = status ? { status } : {};
    const slips = await prisma.paymentSlip.findMany({
      where,
      orderBy: { created_at: "desc" },
    });
    res.json({ ok: true, slips });
  } catch (err) {
    console.error("admin list slips error:", err);
    res.status(500).json({ ok: false, message: err.message || "server error" });
  }
};

// PATCH /api/admin/slips/:id { status }
exports.adminUpdateSlipStatus = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!["PENDING", "APPROVED", "REJECTED"].includes(String(status || "")))
      return res.status(400).json({ ok: false, message: "invalid status" });

    const updated = await prisma.paymentSlip.update({
      where: { id },
      data: { status },
    });
    res.json({ ok: true, slip: updated });
  } catch (err) {
    console.error("admin update slip error:", err);
    res.status(500).json({ ok: false, message: err.message || "server error" });
  }
};

// DELETE /api/admin/slips/:id
exports.adminDeleteSlip = async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.paymentSlip.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("admin delete slip error:", err);
    res.status(500).json({ ok: false, message: err.message || "server error" });
  }
};
