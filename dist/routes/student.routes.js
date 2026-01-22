"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/students.ts
const express_1 = require("express");
const db_1 = require("../lib/db");
const router = (0, express_1.Router)();
// --------------------
// List students
// --------------------
router.get("/", async (req, res, next) => {
    try {
        const students = await (0, db_1.withTenantClient)(req.tenantId, async (client) => {
            const { rows } = await client.query("SELECT * FROM students ORDER BY id ASC");
            return rows;
        });
        res.json(students);
    }
    catch (err) {
        next(err);
    }
});
// --------------------
// Add student
// --------------------
router.post("/", async (req, res, next) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ error: "Name is required" });
        }
        const student = await (0, db_1.withTenantClient)(req.tenantId, async (client) => {
            const { rows } = await client.query("INSERT INTO students(name) VALUES($1) RETURNING *", [name]);
            return rows[0];
        });
        res.status(201).json(student);
    }
    catch (err) {
        next(err);
    }
});
// --------------------
// Update student
// --------------------
router.put("/:id", async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ error: "Name is required" });
        }
        const student = await (0, db_1.withTenantClient)(req.tenantId, async (client) => {
            const { rows } = await client.query("UPDATE students SET name=$1 WHERE id=$2 RETURNING *", [name, id]);
            return rows[0];
        });
        if (!student) {
            return res.status(404).json({ error: "Student not found" });
        }
        res.json(student);
    }
    catch (err) {
        next(err);
    }
});
// --------------------
// Delete student
// --------------------
router.delete("/:id", async (req, res, next) => {
    try {
        const { id } = req.params;
        const student = await (0, db_1.withTenantClient)(req.tenantId, async (client) => {
            const { rows } = await client.query("DELETE FROM students WHERE id=$1 RETURNING *", [id]);
            return rows[0];
        });
        if (!student) {
            return res.status(404).json({ error: "Student not found" });
        }
        res.json(student);
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
