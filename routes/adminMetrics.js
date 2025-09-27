// routes/adminMetrics.js
const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { authCheck, adminCheck } = require("../middlewares/auth");

// NOTE: ถ้า mount ด้วย app.use("/api/admin", router) ให้ path เป็น "/metrics"
//       ถ้า mount ด้วย app.use("/api", router) ให้ path เป็น "/admin/metrics"
router.get("/metrics", authCheck, adminCheck, async (_req, res) => {
  try {
    // ดึงข้อมูลหลักพร้อมกัน
    const [
      usersCount,
      productsCount,
      ordersCount,           // ← จะตั้งค่าเป็นจำนวน "สลิปทั้งหมด"
      pendingCount,
      approvedSlips,
      categories,
      lowStock,
    ] = await Promise.all([
      prisma.user.count({ where: { enabled: true } }),
      prisma.product.count({ where: { deleted: false } }),
      // ---------------------- CHANGED ----------------------
      // เดิม: prisma.order.count(),
      prisma.paymentSlip.count(), // นับจากสลิปทั้งหมดให้ตรงกับหน้า Approve
      // -----------------------------------------------------
      prisma.paymentSlip.count({ where: { status: "PENDING" } }),
      prisma.paymentSlip.findMany({
        where: { status: "APPROVED" },
        select: { amount: true, created_at: true },
      }),
      prisma.category.findMany({
        select: {
          name: true,
          products: { where: { deleted: false }, select: { id: true } },
        },
        orderBy: { name: "asc" },
      }),
      prisma.product.findMany({
        where: { deleted: false },
        select: { id: true, title: true, quantity: true },
        orderBy: { quantity: "asc" },
        take: 5,
      }),
    ]);

    // รวมรายได้ที่อนุมัติ
    const revenueApproved = approvedSlips.reduce(
      (s, x) => s + Number(x.amount || 0),
      0
    );

    // ทำ bucket 14 วันล่าสุด
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date();
    start.setDate(end.getDate() - 13);
    start.setHours(0, 0, 0, 0);

    const buckets = {};
    for (let i = 0; i < 14; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
      buckets[key] = { date: key, revenue: 0, orders: 0 };
    }

    for (const s of approvedSlips) {
      const t = s.created_at;
      if (!t) continue;
      const d = new Date(t);
      if (Number.isNaN(d.getTime())) continue;
      const key = d.toISOString().slice(0, 10);
      if (!buckets[key]) continue; // ถ้านอกช่วง 14 วัน ตัดออก
      buckets[key].revenue += Number(s.amount || 0);
      buckets[key].orders += 1;
    }
    const salesByDay = Object.values(buckets);

    const productsByCategory = categories.map((c) => ({
      category: c.name,
      count: c.products.length,
    }));

    return res.json({
      data: {
        kpis: {
          users: usersCount,
          products: productsCount,
          orders: ordersCount,           // ← ตัวเลขนี้จะเท่ากับจำนวนสลิปทั้งหมด
          revenueApproved,
          pending: pendingCount,
        },
        salesByDay,
        productsByCategory,
        lowStock: lowStock.map((p) => ({
          id: p.id,
          title: p.title,
          quantity: Number(p.quantity || 0),
        })),
      },
    });
  } catch (err) {
    console.error("GET /api/admin/metrics error:", err);
    return res
      .status(500)
      .json({ message: "metrics error", detail: String(err?.message || err) });
  }
});

module.exports = router;
