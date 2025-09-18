// routes/admin.slips.js  (mysql2/pg ผ่าน req.db)
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// GET /api/admin/slips?status=PENDING|APPROVED|REJECTED
router.get('/admin/slips', async (req, res) => {
  try {
    const statusQ = String(req.query.status || 'PENDING').toUpperCase();
    const allow = ['PENDING', 'APPROVED', 'REJECTED'];
    const status = allow.includes(statusQ) ? statusQ : 'PENDING';

    const [rows] = await req.db.query(
      `SELECT id, cart_id, user_id, amount, slip_path, status, created_at, updated_at
         FROM payment_slips
        WHERE status = ?
        ORDER BY created_at DESC`,
      [status]
    );
    const host =  `${req.protocol}://${req.get('host')}`;
    const items = rows.map(row => ({
      ...row,
      slip_path: row.slip_path ? host + row.slip_path : null,
    }));
    res.json({ ok: true, items });
  } catch (e) {
    console.error('GET /admin/slips error:', e);
    res.status(500).json({ ok: false, message: 'ดึงข้อมูลไม่สำเร็จ' });
  }
});

// PATCH /api/admin/slips/:id   body: { action: 'approve'|'reject' }
router.patch('/admin/slips/:id', async (req, res) => {
  try {
    const db = req.db;
    const id = Number(req.params.id);
    const { action } = req.body || {};
    if (!['approve','reject'].includes(String(action))) {
      return res.status(400).json({ ok: false, message: 'action ต้องเป็น approve หรือ reject' });
    }
    const next = action === 'approve' ? 'APPROVED' : 'REJECTED';

    // อ่านสถานะเดิม
    const [[slip]] = await db.query(
      `SELECT id, status FROM payment_slips WHERE id = ?`,
      [id]
    );
    if (!slip) return res.status(404).json({ ok: false, message: 'ไม่พบสลิป' });

    // ถ้าอนุมัติ: set ธงแบบอะตอมมิก, แล้วค่อยหักสต็อกจาก snapshot เฉพาะครั้งแรก
    if (next === 'APPROVED' && String(slip.status).toUpperCase() !== 'APPROVED') {
      const isPg = db.dialect === 'postgres';

      // guard ธง
      let firstTime = false;
      if (isPg) {
        const [rows] = await db
          .query(
            `UPDATE payment_slips
               SET stock_deducted = TRUE
             WHERE id = ?
               AND COALESCE(stock_deducted, FALSE) = FALSE
             RETURNING id`,
            [id]
          )
          .catch(() => [[]]);
        firstTime = !!rows?.length;
      } else {
        const [r] = await db
          .query(
            `UPDATE payment_slips
               SET stock_deducted = TRUE
             WHERE id = ?
               AND COALESCE(stock_deducted, FALSE) = FALSE`,
            [id]
          )
          .catch(() => [{}]);
        firstTime = (r?.affectedRows ?? r?.rowCount ?? 0) > 0;
      }

      if (firstTime) {
        // ใช้ snapshot จาก payment_slip_items → อัปเดต product/"Product" แบบปลอดภัย
        const [items] = await db.query(
          `SELECT product_id AS pid, SUM(qty) AS qty
             FROM payment_slip_items
            WHERE slip_id = ?
            GROUP BY product_id`,
          [id]
        );
        for (const it of items || []) {
          const pid = Number(it.pid);
          const qty = Number(it.qty || 0);
          if (!pid || !qty) continue;

          await db
            .query(
              `UPDATE product
                 SET sold = sold + LEAST(quantity, ?),
                     quantity = GREATEST(quantity - ?, 0)
               WHERE id = ?`,
              [qty, qty, pid]
            )
            .catch(() => {});
          await db
            .query(
              `UPDATE "Product"
                 SET sold = sold + LEAST(quantity, ?),
                     quantity = GREATEST(quantity - ?, 0)
               WHERE id = ?`,
              [qty, qty, pid]
            )
            .catch(() => {});
        }
      }
    }

    await db.query(
      `UPDATE payment_slips SET status = ?, updated_at = NOW() WHERE id = ?`,
      [next, id]
    );

    res.json({ ok: true, message: `อัปเดตเป็น ${next} แล้ว` });
  } catch (e) {
    console.error('PATCH /admin/slips/:id error:', e);
    res.status(500).json({ ok: false, message: 'อัปเดตไม่สำเร็จ' });
  }
});

// DELETE /api/admin/slips/:id
router.delete('/admin/slips/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [[slip]] = await req.db.query(
      `SELECT slip_path FROM payment_slips WHERE id = ?`,
      [id]
    );
    if (!slip) return res.status(404).json({ ok: false, message: 'ไม่พบสลิป' });

    const mode = process.env.SLIP_DELETE_MODE || 'hard';
    if (mode === 'soft') {
      await req.db.query(
        `UPDATE payment_slips SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [id]
      );
      return res.json({ ok: true, mode, message: 'ซ่อนสลิปแล้ว' });
    }

    if (slip.slip_path) {
      const abs = path.join(__dirname, '..', slip.slip_path.replace(/^[\\/]+/, ''));
      try { if (fs.existsSync(abs)) await fs.promises.unlink(abs); } catch (_) {}
    }
    await req.db.query(`DELETE FROM payment_slips WHERE id = ?`, [id]);
    res.json({ ok: true, mode: 'hard', message: 'ลบสลิปแล้ว' });
  } catch (e) {
    console.error('DELETE /admin/slips/:id error:', e);
    res.status(500).json({ ok: false, message: 'ลบไม่สำเร็จ' });
  }
});

module.exports = router;
