/*
  Warnings:

  - You are about to alter the column `orderStatus` on the `order` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `Enum(EnumId(0))`.

*/
-- AlterTable
ALTER TABLE `order` MODIFY `orderStatus` ENUM('Not_Process', 'Pending', 'Processing', 'Completed', 'Cancelled') NOT NULL DEFAULT 'Not_Process';
