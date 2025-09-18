// server/routes/image.js
const express = require("express");
const router = express.Router();
const { authCheck } = require("../middlewares/auth");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer: รับไฟล์เข้าหน่วยความจำ (ไม่เขียนลงดิสก์)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB/ไฟล์
});

// helper map ผลลัพธ์
const mapResult = (r) => ({
  asset_id:  r.asset_id,
  public_id: r.public_id,
  url:       r.url,
  secure_url:r.secure_url,
  width:     r.width,
  height:    r.height,
  format:    r.format,
});

// อัปโหลดรูป: รองรับทั้ง data URL และ multipart/form-data
router.post("/images", authCheck, upload.any(), async (req, res) => {
  try {
    const bodyImage = req.body?.image;

    // กรณีส่งเป็น data URL (เช่น "data:image/png;base64,...")
    if (bodyImage && typeof bodyImage === "string") {
      const r = await cloudinary.uploader.upload(bodyImage, {
        folder: "products",
        resource_type: "image",
      });
      return res.json(mapResult(r));
    }

    // กรณีส่งเป็นไฟล์ (FormData) ฟิลด์ชื่อ "file" หรือ "files"
    const files = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    if (files.length) {
      // แปลง buffer -> data URL แล้วอัปขึ้น Cloudinary
      const results = await Promise.all(
        files.map((f) => {
          const dataUrl = `data:${f.mimetype};base64,${f.buffer.toString("base64")}`;
          return cloudinary.uploader.upload(dataUrl, {
            folder: "products",
            resource_type: "image",
          });
        })
      );
      // ถ้ามีไฟล์เดียว ส่งออบเจ็กต์เดียว, หลายไฟล์ส่งเป็น items[]
      return results.length === 1
        ? res.json(mapResult(results[0]))
        : res.json({ items: results.map(mapResult) });
    }

    return res.status(400).json({ ok: false, message: "missing image" });
  } catch (e) {
    console.error("upload /images error:", e);
    res.status(500).json({ ok: false, message: e.message || "upload failed" });
  }
});

// ลบรูป: POST /api/removeimages  { public_id }
router.post("/removeimages", authCheck, async (req, res) => {
  try {
    const { public_id } = req.body || {};
    if (!public_id) return res.status(400).json({ ok: false, message: "missing public_id" });

    const r = await cloudinary.uploader.destroy(public_id, { invalidate: true });
    res.json({ ok: true, result: r.result });
  } catch (e) {
    console.error("remove /removeimages error:", e);
    res.status(500).json({ ok: false, message: e.message || "remove failed" });
  }
});

module.exports = router;
