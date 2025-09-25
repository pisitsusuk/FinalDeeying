// server/routes/admin.js
const express = require("express");
const router = express.Router();

// ✅ ใช้ไฟล์ middleware เดิม
const { authCheck, adminCheck } = require("../middlewares/auth");

// ✅ ดึงทุกฟังก์ชันที่ต้องใช้ รวมถึง listSlips
const {
  changeOrderStatus,
  getOrderAdmin,
  listUsers,
  setRole,
  setEnabled,
  getBankInfo,
  updateBankInfo,
  listSlips,
  deleteUser,           // <-- เพิ่มอันนี้
} = require("../controllers/admin");

/* ===== Orders ===== */
router.put("/admin/order-status", authCheck, adminCheck, changeOrderStatus);
router.get("/admin/orders", authCheck, adminCheck, getOrderAdmin);

/* ===== Users ===== */
router.get("/admin/users", authCheck, adminCheck, listUsers);
router.patch("/admin/users/:id/role", authCheck, adminCheck, setRole);
router.patch("/admin/users/:id/enabled", authCheck, adminCheck, setEnabled);
router.delete("/admin/users/:id", authCheck, adminCheck, deleteUser); // <-- เพิ่มบรรทัดนี้
/* ===== Bank Info ===== */
router.get("/admin/bank-info", authCheck, adminCheck, getBankInfo);
router.put("/admin/bank-info", authCheck, adminCheck, updateBankInfo);

/* ===== Slips / Approve หน้าแอดมิน ===== */
router.get("/admin/approve", authCheck, adminCheck, listSlips);

module.exports = router;
