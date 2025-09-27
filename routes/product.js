// server/routes/product.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const { authCheck, adminCheck } = require("../middlewares/authCheck");

const {
  create,
  listProducts,
  read,
  update,
  remove,
  searchFilters,
  listProductBy,
  uploadImages,
  removeImages,
} = require("../controllers/product");

// === Multer temp storage (แค่รับไฟล์แล้วส่งต่อ Cloudinary/ที่เก็บจริง) ===
const upload = multer({
  storage: multer.memoryStorage(), // ใช้ memory จะสะดวกกับ cloudinary.upload_stream
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});


// ---------- Product CRUD ----------
router.post("/product", authCheck, adminCheck, create);
router.get("/products/:count", listProducts);
router.get("/product/:id", authCheck, read);
router.put("/product/:id", authCheck, adminCheck, update);
router.delete("/product/:id", authCheck, adminCheck, remove);

router.post("/search/filters", searchFilters);
router.post("/productby", listProductBy);

// ---------- Images ----------
// ✅ รองรับ multipart ด้วย upload.single('image') และใน controller จะรองรับ base64 ด้วย
router.post("/images", authCheck, adminCheck, upload.any(), uploadImages);
router.post("/removeimages", authCheck, adminCheck, removeImages);

module.exports = router;
