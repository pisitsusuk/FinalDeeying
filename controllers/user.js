const prisma = require("../config/prisma");

// ✅ ดึงรายชื่อผู้ใช้ (ส่งกลับเป็น items ให้ตรงกับฝั่งหน้า)
exports.listUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        enabled: true,
        address: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ ok: true, items: users }); // <<< เปลี่ยน users -> items
  } catch (err) {
    console.error("listUsers error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};

// ✅ เปลี่ยนสถานะเปิด/ปิดการใช้งาน (normalize ค่าที่รับมา)
exports.changeStatus = async (req, res) => {
  try {
    const id = Number(req.body?.id);
    const enabledRaw = req.body?.enabled;
    // รองรับ true/false, "1"/"0", 1/0
    const enabled = Number(enabledRaw) ? 1 : 0;

    if (!id) return res.status(400).json({ ok: false, message: "invalid id" });

    await prisma.user.update({
      where: { id },
      data: { enabled },
    });

    res.json({ ok: true, message: "Update Status Success", id, enabled });
  } catch (err) {
    console.error("changeStatus error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};

// ✅ เปลี่ยนสิทธิ์การเข้าถึง (validate role)
exports.changeRole = async (req, res) => {
  try {
    const id = Number(req.body?.id);
    const role = String(req.body?.role || "").toLowerCase();
    const allow = ["user", "admin"];
    if (!id || !allow.includes(role)) {
      return res.status(400).json({ ok: false, message: "invalid id or role" });
    }

    await prisma.user.update({
      where: { id },
      data: { role },
    });

    res.json({ ok: true, message: "Update Role Success", id, role });
  } catch (err) {
    console.error("changeRole error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};

// ✅ เพิ่มสินค้าลงตะกร้า
exports.userCart = async (req, res) => {
  try {
    const { cart } = req.body;
    const user = await prisma.user.findFirst({
      where: { id: Number(req.user.id) },
    });

    // ตรวจสอบจำนวนสินค้า
    for (const item of cart) {
      const product = await prisma.product.findUnique({
        where: { id: item.id },
        select: { quantity: true, title: true },
      });
      if (!product || item.count > product.quantity) {
        return res.status(400).json({
          ok: false,
          message: `ขออภัย สินค้า ${product?.title || "product"} หมด`,
        });
      }
    }

    // ลบตะกร้าเก่า
    await prisma.productOnCart.deleteMany({
      where: { cart: { orderedById: user.id } },
    });
    await prisma.cart.deleteMany({
      where: { orderedById: user.id },
    });

    // เตรียมสินค้าใหม่
    const products = cart.map((item) => ({
      productId: item.id,
      count: item.count,
      price: item.price,
    }));
    const cartTotal = products.reduce((sum, it) => sum + it.price * it.count, 0);

    // สร้างตะกร้าใหม่
    await prisma.cart.create({
      data: {
        products: { create: products },
        cartTotal,
        orderedById: user.id,
      },
    });

    res.json({ ok: true, message: "Add Cart Ok" });
  } catch (err) {
    console.error("userCart error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};

// ✅ ดึงข้อมูลตะกร้าผู้ใช้
exports.getUserCart = async (req, res) => {
  try {
    const cart = await prisma.cart.findFirst({
      where: { orderedById: Number(req.user.id) },
      include: { products: { include: { product: true } } },
    });

    if (!cart) return res.json({ ok: true, products: [], cartTotal: 0 });

    res.json({ ok: true, products: cart.products, cartTotal: cart.cartTotal });
  } catch (err) {
    console.error("getUserCart error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};

// ✅ ลบตะกร้าสินค้า
exports.emptyCart = async (req, res) => {
  try {
    const cart = await prisma.cart.findFirst({
      where: { orderedById: Number(req.user.id) },
    });
    if (!cart) return res.json({ ok: true, message: "No cart to delete" });

    await prisma.productOnCart.deleteMany({ where: { cartId: cart.id } });
    const result = await prisma.cart.deleteMany({
      where: { orderedById: Number(req.user.id) },
    });

    res.json({ ok: true, message: "Cart Empty Success", deletedCount: result.count });
  } catch (err) {
    console.error("emptyCart error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};

// ✅ บันทึกที่อยู่ผู้ใช้
exports.saveAddress = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthenticated" });

    let { address } = req.body;
    if (typeof address !== "string" || !address.trim()) {
      return res.status(400).json({ ok: false, message: "address is required" });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { address: address.trim() },
      select: { id: true, address: true, email: true },
    });

    res.json({ ok: true, message: "Address update success", user: updated });
  } catch (err) {
    console.error("saveAddress error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};

// ✅ สร้างคำสั่งซื้อ
exports.saveOrder = async (req, res) => {
  try {
    const { id, amount, status, currency } = req.body.paymentIntent;

    const userCart = await prisma.cart.findFirst({
      where: { orderedById: Number(req.user.id) },
      include: { products: true },
    });
    if (!userCart || userCart.products.length === 0) {
      return res.status(400).json({ ok: false, message: "Cart is Empty" });
    }

    const amountTHB = Number(amount) / 100;

    const order = await prisma.order.create({
      data: {
        products: {
          create: userCart.products.map((it) => ({
            productId: it.productId,
            count: it.count,
            price: it.price,
          })),
        },
        orderedBy: { connect: { id: req.user.id } },
        cartTotal: userCart.cartTotal,
        stripePaymentId: id,
        amount: amountTHB,
        status,
        currency,
      },
    });

    await Promise.all(
      userCart.products.map((it) =>
        prisma.product.update({
          where: { id: it.productId },
          data: { quantity: { decrement: it.count }, sold: { increment: it.count } },
        })
      )
    );

    await prisma.cart.deleteMany({ where: { orderedById: Number(req.user.id) } });

    res.json({ ok: true, order });
  } catch (err) {
    console.error("saveOrder error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};

// ✅ ดึงประวัติคำสั่งซื้อ
exports.getOrder = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { orderedById: Number(req.user.id) },
      include: { products: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ ok: true, orders });
  } catch (err) {
    console.error("getOrder error:", err);
    res.status(500).json({ ok: false, message: "Server Error" });
  }
};



exports.remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "id ไม่ถูกต้อง" });
    }

    // เช็กเฉพาะ "สลิป"
    const slipCount = await prisma.paymentSlip
      .count({ where: { user_id: id } })
      .catch(() => 0);

    if (slipCount > 0) {
      return res.status(409).json({
        ok: false,
        code: "USER_HAS_SLIPS",
        message: `ลบผู้ใช้ไม่ได้: พบสลิป ${slipCount} ใบ`,
        counts: { slips: slipCount },
      });
    }

    // ไม่มีสลิป → เคลียร์ความสัมพันธ์ที่เหลือแล้วลบ user (กันติด FK)
    await prisma.$transaction(async (tx) => {
      // carts + productOnCart + cart_addresses
      const carts = await tx.cart.findMany({
        where: { orderedById: id },
        select: { id: true },
      });
      const cartIds = carts.map((c) => c.id);

      if (cartIds.length) {
        await tx.productOnCart.deleteMany({ where: { cartId: { in: cartIds } } });
        // cart_addresses ไม่มีใน Prisma → ลบแบบ raw ทั้ง 2 case (pg/mysql)
        for (const cid of cartIds) {
          await tx.$executeRaw`DELETE FROM cart_addresses WHERE "cartId" = ${cid}`;
          await tx.$executeRaw`DELETE FROM cart_addresses WHERE cart_id = ${cid}`;
        }
        await tx.cart.deleteMany({ where: { id: { in: cartIds } } });
      }

      // orders + productOnOrder
      const orders = await tx.order.findMany({
        where: { orderedById: id },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);
      if (orderIds.length) {
        await tx.productOnOrder.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      // เผื่อมีสลิปค้าง (ตามเงื่อนไขปกติควรเป็น 0)
      await tx.paymentSlip.deleteMany({ where: { user_id: id } });

      // ลบผู้ใช้จริง
      await tx.user.delete({ where: { id } });
    });

    return res.json({ ok: true, deletedId: id });
  } catch (err) {
    if (err?.code === "P2025") {
      return res.status(404).json({ ok: false, message: "ไม่พบผู้ใช้" });
    }
    if (err?.code === "P2003") {
      return res.status(409).json({
        ok: false,
        message: "ลบผู้ใช้ไม่ได้ เนื่องจากข้อมูลยังถูกอ้างอิงในระบบ",
      });
    }
    console.error("user.remove error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
};
