// server/controllers/admin.js
const prisma = require("../config/prisma");

/* ===================== ORDERS (ของเดิม) ===================== */

// ✅ เปลี่ยนสถานะ Order
exports.changeOrderStatus = async (req, res) => {
  try {
    const { orderId, orderStatus } = req.body;

    if (!orderId || !orderStatus) {
      return res.status(400).json({ ok: false, message: "Missing required fields" });
    }

    const orderUpdate = await prisma.order.update({
      where: { id: Number(orderId) },
      data: { orderStatus },
    });

    res.json({ ok: true, message: "Order status updated", order: orderUpdate });
  } catch (err) {
    console.error("changeOrderStatus Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
};

// ✅ ดึงรายการ Order ทั้งหมด (ฝั่งแอดมิน)
exports.getOrderAdmin = async (_req, res) => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        products: { include: { product: true } },
        orderedBy: { select: { id: true, email: true, address: true } },
      },
      orderBy: { id: "desc" },
    });

    res.json({ ok: true, orders });
  } catch (err) {
    console.error("getOrderAdmin Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
};

console.log("DEBUG => changeOrderStatus:", typeof exports.changeOrderStatus);
console.log("DEBUG => getOrderAdmin:", typeof exports.getOrderAdmin);

/* ===================== USERS (เพิ่มใหม่) ===================== */

// ✅ รายชื่อผู้ใช้ สำหรับหน้า Manage
exports.listUsers = async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, role: true, enabled: true, createdAt: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    res.json({ ok: true, items: users });
  } catch (err) {
    console.error("listUsers error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
};

// ✅ เปลี่ยนสิทธิ์ผู้ใช้ (user <-> admin)
exports.setRole = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { role } = req.body;

    if (!id) return res.status(400).json({ ok: false, message: "invalid id" });
    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ ok: false, message: "invalid role" });
    }

    const user = await prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, email: true, role: true, enabled: true },
    });

    res.json({ ok: true, user, message: "Role updated" });
  } catch (err) {
    console.error("setRole error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
};

// ✅ เปิด/ปิดการใช้งานผู้ใช้ (Disable/Enable)
exports.setEnabled = async (req, res) => {
  try {
    const id = Number(req.params.id);
    let { enabled } = req.body;

    if (!id) return res.status(400).json({ ok: false, message: "invalid id" });

    // รองรับ true/false, "1"/"0", 1/0
    if (typeof enabled === "string") enabled = ["1", "true", "True"].includes(enabled);

    const user = await prisma.user.update({
      where: { id },
      data: { enabled: Boolean(enabled) },
      select: { id: true, email: true, role: true, enabled: true },
    });

    res.json({ ok: true, user, message: enabled ? "Enabled user" : "Disabled user" });
  } catch (err) {
    console.error("setEnabled error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
};

/* ===================== BANK INFO ===================== */

exports.getBankInfo = async (_req, res) => {
  try {
    const bankInfo = await prisma.bankInfo.findFirst();
    res.json(bankInfo);
  } catch (error) {
    res.status(500).json({ error: "ไม่สามารถดึงข้อมูลธนาคารได้" });
  }
};

exports.updateBankInfo = async (req, res) => {
  const { bankName, accountNumber, accountName, qrCodeImage, bankLogo } = req.body;
  try {
    const updatedBankInfo = await prisma.bankInfo.update({
      where: { id: 1 }, // สมมุติว่ามีข้อมูลธนาคารหนึ่งรายการ
      data: { bankName, accountNumber, accountName, qrCodeImage, bankLogo },
    });
    res.json(updatedBankInfo);
  } catch (error) {
    res.status(500).json({ error: "ไม่สามารถอัปเดตข้อมูลธนาคารได้" });
  }
};

/* ===================== SLIPS (ใหม่สำหรับหน้า Approve) ===================== */

// ✅ ดึงรายการสลิป + ผูกผู้ใช้ + ที่อยู่จัดส่งจาก cart_addresses
const ALLOW = ["PENDING", "APPROVED", "REJECTED"];

exports.listSlips = async (req, res) => {
  try {
    const qStatus = String(req.query.status || "").toUpperCase();
    const hasFilter = ALLOW.includes(qStatus);

    // ใช้ raw SQL เพื่อ join ตารางที่ไม่ได้สร้าง relation ใน Prisma
    const rows = await prisma.$queryRawUnsafe(
      `
      SELECT 
        ps.id,
        ps.cart_id          AS cartId,
        ps.user_id          AS userId,
        ps.amount,
        ps.status,
        ps.slip_path,
        ps.created_at       AS createdAt,
        ps.updated_at       AS updatedAt,
        ca.address          AS shippingAddress,
        u.email             AS userEmail,
        u.name              AS userName
      FROM payment_slips ps
      LEFT JOIN cart_addresses ca ON ca.cartId = ps.cart_id
      LEFT JOIN \`User\` u        ON u.id = ps.user_id
      ${hasFilter ? "WHERE ps.status = ?" : ""}
      ORDER BY ps.created_at DESC
      `,
      ...(hasFilter ? [qStatus] : [])
    );

    res.json({ ok: true, items: rows || [] });
  } catch (error) {
    console.error("❌ admin.listSlips error:", error);
    res.status(500).json({ ok: false, message: "ไม่สามารถดึงรายการสลิปได้" });
  }
};


// ✅ ลบผู้ใช้แบบถาวร (hard delete) — ลบความสัมพันธ์ก่อน แล้วค่อยลบ user
exports.deleteUser = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, message: "invalid id" });

  try {
    await prisma.$transaction(async (tx) => {
      // ----- 1) ลบตะกร้า + รายการในตะกร้า + cart_addresses -----
      const carts = await tx.cart.findMany({
        where: { orderedById: id },
        select: { id: true },
      });
      const cartIds = carts.map((c) => c.id);

      if (cartIds.length) {
        await tx.productOnCart.deleteMany({ where: { cartId: { in: cartIds } } });

        // cart_addresses ไม่อยู่ใน Prisma schema → ใช้ raw
        for (const cid of cartIds) {
          await tx.$executeRaw`DELETE FROM cart_addresses WHERE "cartId" = ${cid}`;
        }

        await tx.cart.deleteMany({ where: { id: { in: cartIds } } });
      }

      // ----- 2) ลบออเดอร์ + รายการในออเดอร์ -----
      const orders = await tx.order.findMany({
        where: { orderedById: id },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);

      if (orderIds.length) {
        await tx.productOnOrder.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      // ----- 3) ลบสลิปโอน + รายการสินค้าในสลิป -----
      const slips = await tx.$queryRaw`SELECT id FROM payment_slips WHERE user_id = ${id}`;
      const slipIds = (slips || []).map((s) => s.id);

      for (const sid of slipIds) {
        await tx.$executeRaw`DELETE FROM payment_slip_items WHERE slip_id = ${sid}`;
        await tx.$executeRaw`DELETE FROM payment_slips WHERE id = ${sid}`;
      }

      // ----- 4) ลบผู้ใช้จริง -----
      await tx.user.delete({ where: { id } });
    });

    return res.json({ ok: true, deletedId: id, message: "User deleted permanently" });
  } catch (err) {
    console.error("hard deleteUser error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Server error", detail: String(err?.meta?.message || err?.message || err) });
  }
};


