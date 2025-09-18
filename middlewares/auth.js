const jwt = require("jsonwebtoken");
require("dotenv").config();

exports.authCheck = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, message: "Missing Authorization header" });
    }
    const [scheme, token] = authHeader.split(" ");
    if (!/^Bearer$/i.test(scheme) || !token) {
      return res.status(401).json({ ok: false, message: "Invalid Authorization format" });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, role, ... }
    return next();
  } catch (err) {
    console.error("Auth Middleware Error:", err.message);
    return res.status(401).json({ ok: false, message: "Invalid or expired token" });
  }
};

exports.adminCheck = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
    const role = String(req.user.role || "").toUpperCase();
    if (role !== "ADMIN") {
      return res.status(403).json({ ok: false, message: "Forbidden: Admins only" });
    }
    return next();
  } catch (err) {
    console.error("Admin Middleware Error:", err.message);
    return res.status(403).json({ ok: false, message: "Forbidden" });
  }
};
