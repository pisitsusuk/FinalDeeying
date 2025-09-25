// server/controllers/category.js
const prisma = require("../config/prisma");

exports.create = async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok:false, message:"กรุณากรอกชื่อหมวดหมู่" });

    const item = await prisma.category.create({ data: { name } });
    return res.status(201).json({ ok:true, item });
  } catch (err) {
    if (err?.code === "P2002") { // unique name ซ้ำ
      return res.status(409).json({ ok:false, message:"ชื่อนี้มีอยู่แล้ว" });
    }
    console.error("category.create error:", err);
    return res.status(500).json({ ok:false, message:"Server error" });
  }
};

exports.list = async (req, res) => {
  try {
    const q = (req.query?.q || "").trim();
    const where = q ? { name: { contains: q } } : undefined;
    const items = await prisma.category.findMany({ where, orderBy:[{name:"asc"},{id:"asc"}] });
    return res.json({ ok:true, items });
  } catch (err) {
    console.error("category.list error:", err);
    return res.status(500).json({ ok:false, message:"Server error" });
  }
};

exports.remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok:false, message:"id ไม่ถูกต้อง" });

    const item = await prisma.category.delete({ where:{ id } });
    return res.json({ ok:true, item });
  } catch (err) {
    if (err?.code === "P2003") {
      return res.status(409).json({ ok:false, message:"ลบไม่ได้ มีสินค้าที่ใช้หมวดนี้อยู่" });
    }
    console.error("category.remove error:", err);
    return res.status(500).json({ ok:false, message:"Server error" });
  }
};

exports.updateCategory = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = (req.body?.name || "").trim();

    if (!Number.isFinite(id)) return res.status(400).json({ ok:false, message:"id ไม่ถูกต้อง" });
    if (!name) return res.status(400).json({ ok:false, message:"กรุณากรอกชื่อหมวดหมู่" });

    const item = await prisma.category.update({ where:{ id }, data:{ name } });
    return res.json({ ok:true, item });
  } catch (err) {
    if (err?.code === "P2025") return res.status(404).json({ ok:false, message:"ไม่พบหมวดหมู่" });
    if (err?.code === "P2002") return res.status(409).json({ ok:false, message:"ชื่อนี้มีอยู่แล้ว" });
    console.error("category.update error:", err);
    return res.status(500).json({ ok:false, message:"อัปเดตหมวดหมู่ไม่สำเร็จ" });
  }
};
