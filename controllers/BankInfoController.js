// controllers/BankInfoController.js
const path = require("path");
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const cloudinary = require("cloudinary").v2;
const prisma = new PrismaClient();

// -------- helpers --------
const safeUnlink = async (absPath) => {
  try { await fs.promises.unlink(absPath); } catch (_) {}
};

// แปลง web path -> absolute disk path
const toDiskPath = (webPath) => {
  if (!webPath) return null;
  const clean = String(webPath).replace(/\\/g, "/").replace(/^\//, "");
  // __dirname = controllers/, ย้อนกลับหนึ่งระดับไป project root แล้วต่อด้วย clean
  return path.resolve(__dirname, "..", clean);
};

// ดึง public_id จาก Cloudinary URL สำหรับการลบ
const getPublicIdFromUrl = (url) => {
  if (!url || !url.includes('cloudinary.com')) return null;
  try {
    const match = url.match(/\/([^\/]+)\.(jpg|jpeg|png|gif|webp|pdf)$/i);
    if (match) return `bank_info/${match[1]}`;
    return null;
  } catch {
    return null;
  }
};

// รองรับทั้ง prisma.bankInfo (มาตรฐาน Prisma สำหรับ model BankInfo)
// และ prisma.bankinfo (เผื่อ schema เดิมใช้ชื่อแปลก)
const tbl = prisma.bankInfo || prisma.bankinfo;

// ===== GET: /admin/bank-info (ทั้งหมด) หรือ /admin/bank-info/:id (ถ้ามีพาธนี้ในอนาคต) =====
exports.getBankInfo = async (req, res) => {
  try {
    const { id } = req.params || {};
    if (id) {
      const row = await tbl.findUnique({ where: { id: Number(id) } });
      if (!row) return res.status(404).json({ error: "ไม่พบข้อมูลธนาคาร" });
      return res.json(row);
    }

    // ไม่มี id -> ดึงทั้งหมด
    const rows = await tbl.findMany({
      orderBy: { id: "desc" },
      select: {
        id: true,
        bankName: true,
        accountNumber: true,
        accountName: true,
        qrCodeImage: true,   // เก็บ web path เช่น /uploads/banks/xxx.png
        bankLogo: true,      // เก็บ web path
        createdAt: true,
        updatedAt: true,
      },
    });
    return res.json(rows);
  } catch (error) {
    console.error("getBankInfo error:", error);
    return res.status(500).json({ error: "ไม่สามารถดึงข้อมูลธนาคารได้" });
  }
};

// ===== POST: /admin/bank-info =====
// ต้องยิงเป็น multipart/form-data กับ fields:
// - text: bankName, accountNumber, accountName
// - files: qrCodeImage (1 ไฟล์), bankLogo (1 ไฟล์)  → ตาม routes ที่คุณตั้ง upload.fields([...])
exports.createBankInfo = async (req, res) => {
  try {
    console.log("CT:", req.headers["content-type"]);
    console.log("BODY:", req.body);
    console.log("CLOUDINARY:", Object.keys(req.cloudinary || {}));

    const { bankName, accountNumber, accountName } = req.body || {};
    const qrResult = req.cloudinary?.qrCodeImage;
    const logoResult = req.cloudinary?.bankLogo;

    if (!bankName || !accountNumber || !accountName) {
      return res.status(400).json({ error: "กรุณากรอก bankName, accountNumber, accountName ให้ครบ" });
    }
    if (!qrResult || !logoResult) {
      return res.status(400).json({ error: "กรุณาแนบไฟล์ qrCodeImage และ bankLogo" });
    }

    const qrPath = qrResult.secure_url;
    const logoPath = logoResult.secure_url;

    const created = await tbl.create({
      data: {
        bankName,
        accountNumber,
        accountName,
        qrCodeImage: qrPath,
        bankLogo: logoPath
      },
    });

    return res.json({
      ok: true,
      message: "เพิ่มข้อมูลธนาคารสำเร็จ",
      data: {
        ...created,
        qrCodePublicId: qrResult.public_id,
        bankLogoPublicId: logoResult.public_id
      }
    });
  } catch (error) {
    console.error("createBankInfo error:", error);
    return res.status(500).json({ error: "ไม่สามารถเพิ่มข้อมูลธนาคารได้" });
  }
};

// ===== PUT: /admin/bank-info/:id =====
// อัปเดต text; ถ้ามีอัปโหลดไฟล์ใหม่ จะลบไฟล์เก่าจาก Cloudinary แล้วบันทึกของใหม่แทน
exports.updateBankInfo = async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "id ไม่ถูกต้อง" });
    }

    const existing = await tbl.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "ไม่พบข้อมูลธนาคาร" });

    const { bankName, accountNumber, accountName } = req.body || {};
    const qrResult = req.cloudinary?.qrCodeImage;
    const logoResult = req.cloudinary?.bankLogo;

    // เตรียม data อัปเดต
    const data = {};
    if (typeof bankName === "string" && bankName.trim() !== "") data.bankName = bankName.trim();
    if (typeof accountNumber === "string" && accountNumber.trim() !== "") data.accountNumber = accountNumber.trim();
    if (typeof accountName === "string" && accountName.trim() !== "") data.accountName = accountName.trim();

    // ถ้ามีไฟล์ใหม่ -> ลบไฟล์เก่าจาก Cloudinary + เซต URL ใหม่
    if (qrResult) {
      // ลบไฟล์เก่าจาก Cloudinary
      const oldQrPublicId = getPublicIdFromUrl(existing.qrCodeImage);
      if (oldQrPublicId) {
        try {
          await cloudinary.uploader.destroy(oldQrPublicId);
        } catch (err) {
          console.warn("Failed to delete old QR from Cloudinary:", err.message);
        }
      }
      data.qrCodeImage = qrResult.secure_url;
    }

    if (logoResult) {
      // ลบไฟล์เก่าจาก Cloudinary
      const oldLogoPublicId = getPublicIdFromUrl(existing.bankLogo);
      if (oldLogoPublicId) {
        try {
          await cloudinary.uploader.destroy(oldLogoPublicId);
        } catch (err) {
          console.warn("Failed to delete old logo from Cloudinary:", err.message);
        }
      }
      data.bankLogo = logoResult.secure_url;
    }

    const updated = await tbl.update({
      where: { id },
      data,
    });

    return res.json({
      ok: true,
      message: "แก้ไขข้อมูลธนาคารสำเร็จ",
      data: {
        ...updated,
        ...(qrResult && { qrCodePublicId: qrResult.public_id }),
        ...(logoResult && { bankLogoPublicId: logoResult.public_id })
      },
    });
  } catch (error) {
    console.error("updateBankInfo error:", error);
    return res.status(500).json({ error: "ไม่สามารถแก้ไขข้อมูลธนาคารได้" });
  }
};

// ===== DELETE: /admin/bank-info/:id =====
// ลบข้อมูล + ลบไฟล์จาก Cloudinary
exports.deleteBankInfo = async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "id ไม่ถูกต้อง" });
    }

    const existing = await tbl.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "ไม่พบข้อมูลธนาคาร" });

    await tbl.delete({ where: { id } });

    // ลบไฟล์จาก Cloudinary
    const qrPublicId = getPublicIdFromUrl(existing.qrCodeImage);
    const logoPublicId = getPublicIdFromUrl(existing.bankLogo);

    if (qrPublicId) {
      try {
        await cloudinary.uploader.destroy(qrPublicId);
      } catch (err) {
        console.warn("Failed to delete QR from Cloudinary:", err.message);
      }
    }

    if (logoPublicId) {
      try {
        await cloudinary.uploader.destroy(logoPublicId);
      } catch (err) {
        console.warn("Failed to delete logo from Cloudinary:", err.message);
      }
    }

    return res.json({ ok: true, message: "ลบข้อมูลธนาคารสำเร็จ" });
  } catch (error) {
    console.error("deleteBankInfo error:", error);
    return res.status(500).json({ error: "ไม่สามารถลบข้อมูลธนาคารได้" });
  }
};
