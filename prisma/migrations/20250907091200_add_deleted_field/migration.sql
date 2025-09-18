-- AlterTable
ALTER TABLE `product` ADD COLUMN `deleted` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `payment_slips` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `cart_id` INTEGER NOT NULL,
    `user_id` INTEGER NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `slip_path` VARCHAR(255) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `created_at` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
