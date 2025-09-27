const express = require("express");
const router = express.Router();
const { authCheck , adminCheck } = require("../middlewares/authCheck");

const {
  listUsers,
  changeStatus,
  changeRole,
  userCart,
  getUserCart,
  emptyCart,
  saveAddress,
  saveOrder,
  getOrder,
  remove,
} = require("../controllers/user");

/* ==================== USER (เดิม) ==================== */
router.get("/users", authCheck, listUsers);                 // ดึงรายชื่อผู้ใช้
router.post("/user/change-status", authCheck, changeStatus); // เปลี่ยน enabled
router.post("/user/change-role", authCheck, changeRole);     // เปลี่ยน role

/* ==================== USER (เพิ่ม alias แบบ /admin/*) ==================== */
/* ถ้ามี adminCheck ให้เปิดใช้งานแทนคอมเมนต์ไว้จะดีกว่า */
router.get("/admin/users", authCheck /*, adminCheck*/, listUsers);
router.delete("/admin/users/:id", authCheck, adminCheck, remove);
// toggle enable ผ่าน /admin
router.patch("/admin/users/:id/toggle-enable", authCheck /*, adminCheck*/, (req, res) => {
  req.body = {
    id: Number(req.params.id),
    enabled: req.body?.enabled, // รองรับ 1/0, true/false, "1"/"0" (controller แปลงให้แล้ว)
  };
  return changeStatus(req, res);
});

// change role ผ่าน /admin
router.patch("/admin/users/:id/role", authCheck /*, adminCheck*/, (req, res) => {
  req.body = {
    id: Number(req.params.id),
    role: req.body?.role, // 'admin' | 'user'
  };
  return changeRole(req, res);
});

/* ==================== CART ==================== */
router.post("/user/cart", authCheck, userCart);
router.get("/user/cart", authCheck, getUserCart);
router.delete("/user/cart", authCheck, emptyCart);

/* ==================== ADDRESS ==================== */
router.post("/user/address", authCheck, saveAddress);

/* ==================== ORDER ==================== */
router.post("/user/order", authCheck, saveOrder);
router.get("/user/order", authCheck, getOrder);

module.exports = router;
