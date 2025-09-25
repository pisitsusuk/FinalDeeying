const prisma = require("../config/prisma");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ---------- Register ----------
exports.register = async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = String(email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ message: "Email is required" });
    if (!password) return res.status(400).json({ message: "Password is required" });

    // exists?
    const exists = await prisma.user.findFirst({ where: { email } });
    if (exists) return res.status(400).json({ message: "Email already exists" });

    const hashPassword = await bcrypt.hash(password, 10);

    await prisma.user.create({
      data: {
        email,
        password: hashPassword,
        // กัน default ที่อาจไม่ใช่ true
        enabled: true,
      },
    });

    return res.send("Register Success");
  } catch (err) {
    // เผื่อชน unique constraint
    if (err.code === "P2002") {
      return res.status(400).json({ message: "Email already exists" });
    }
    console.error("Register Error:", err);
    return res.status(500).json({ message: "Server Error" });
  }
};

// ---------- Login ----------
exports.login = async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = String(email || "").trim().toLowerCase();
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await prisma.user.findFirst({ where: { email } });
    if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้" });
    if (!user.enabled) return res.status(403).json({ message: "บัญชีถูกปิดการใช้งาน" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ message: "รหัสผ่านไม่ถูกต้อง" });

    if (!process.env.JWT_SECRET) {
      console.error("Missing JWT_SECRET");
      return res.status(500).json({ message: "Server Error" });
    }

    const payload = { id: user.id, email: user.email, role: user.role };
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" }, (err, token) => {
      if (err) return res.status(500).json({ message: "Server Error" });
      return res.status(200).json({ message: "Login Success", token, payload });
    });
  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({ message: "Server Error" });
  }
};

// ---------- Current User ----------
exports.currentUser = async (req, res) => {
  try {
    // ต้องมี middleware ตรวจ token แล้ว set req.user มาก่อน
    const user = await prisma.user.findFirst({
      where: { email: req.user.email },
      select: { id: true, email: true, name: true, role: true, enabled: true },
    });
    if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้" });
    return res.json({ user });
  } catch (err) {
    console.error("CurrentUser Error:", err);
    return res.status(500).json({ message: "Server Error" });
  }
};
