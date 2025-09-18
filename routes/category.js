// server/routes/category.js
const express = require("express");
const router = express.Router();

// ใช้ middleware ให้ตรงกับไฟล์ของโปรเจกต์คุณ (เดิม product ใช้ "../middlewares/auth")
const { authCheck, adminCheck } = require("../middlewares/auth");

const {
  create,
  list,
  remove,
  updateCategory,
} = require("../controllers/category");

// GET /api/category
router.get("/category", list);

// POST /api/category
router.post("/category", authCheck, adminCheck, create);

// PUT /api/category/:id
router.put("/category/:id", authCheck, adminCheck, updateCategory);

// DELETE /api/category/:id
router.delete("/category/:id", authCheck, adminCheck, remove);

module.exports = router;
