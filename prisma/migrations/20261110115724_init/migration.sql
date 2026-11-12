-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('PLATFORM', 'TENANT');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('BASIC', 'GROWTH');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('SETUP', 'SUBSCRIPTION', 'PRORATION', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'RAZORPAY', 'OTHER');

-- CreateEnum
CREATE TYPE "TenderType" AS ENUM ('CASH', 'UPI', 'CARD', 'WALLET', 'CREDIT', 'OTHER');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "IdCardStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('ORDERED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DineTableStatus" AS ENUM ('FREE', 'OCCUPIED', 'RESERVED', 'CLEANING');

-- CreateEnum
CREATE TYPE "DineOrderType" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');

-- CreateEnum
CREATE TYPE "DineOrderSource" AS ENUM ('POS', 'WAITER', 'QR');

-- CreateEnum
CREATE TYPE "DineOrderStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DineItemStatus" AS ENUM ('PENDING_ACCEPT', 'NEW', 'SENT', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KotStatus" AS ENUM ('NEW', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockKind" AS ENUM ('INGREDIENT', 'PRODUCT');

-- CreateEnum
CREATE TYPE "DineMovementType" AS ENUM ('OPENING', 'PURCHASE', 'SALE', 'WASTAGE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'OUT_OF_ORDER');

-- CreateEnum
CREATE TYPE "HousekeepingStatus" AS ENUM ('CLEAN', 'DIRTY', 'IN_PROGRESS', 'INSPECTED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('ROOM', 'FOOD', 'LAUNDRY', 'MINIBAR', 'SERVICE', 'OTHER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOID');

-- CreateEnum
CREATE TYPE "BillMovementType" AS ENUM ('OPENING', 'SALE', 'PURCHASE', 'ADJUSTMENT', 'VOID', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspended_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "gstin" TEXT,
    "logo_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "tier" "PlanTier" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "monthly_price" INTEGER NOT NULL,
    "annual_price" INTEGER NOT NULL,
    "setup_fee" INTEGER NOT NULL,
    "grace_days" INTEGER NOT NULL DEFAULT 7,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_catalog" (
    "key" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "default_tier" "PlanTier" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "feature_catalog_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "plan_features" (
    "plan_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("plan_id","feature_key")
);

-- CreateTable
CREATE TABLE "tenant_features" (
    "tenant_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "note" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_features_pkey" PRIMARY KEY ("tenant_id","feature_key")
);

-- CreateTable
CREATE TABLE "product_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "plan_id" UUID NOT NULL,
    "billing_cycle" "BillingCycle" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "start_date" TIMESTAMP(3) NOT NULL,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "grace_days" INTEGER,
    "setup_fee" INTEGER NOT NULL DEFAULT 0,
    "pending_plan_id" UUID,
    "pending_billing_cycle" "BillingCycle",
    "auto_renew" BOOLEAN NOT NULL DEFAULT true,
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "last_reminder_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "meta" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_product_settings" (
    "tenant_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_product_settings_pkey" PRIMARY KEY ("tenant_id","product_code")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "doc_sequences" (
    "scope" TEXT NOT NULL,
    "tenant_id" UUID,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "doc_sequences_pkey" PRIMARY KEY ("scope")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" "UserKind" NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "platform_role" TEXT,
    "is_tenant_owner" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "home_screen" TEXT NOT NULL DEFAULT '',
    "is_system" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "user_product_access" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_product_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID,
    "actor_id" UUID,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "product_code" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "product_code" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID,
    "invoice_no" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "product_code" TEXT,
    "description" TEXT NOT NULL,
    "plan_id" UUID,
    "billing_cycle" "BillingCycle",
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "subtotal" INTEGER NOT NULL,
    "tax_amount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "due_date" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID,
    "subscription_id" UUID,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "reference" TEXT,
    "gateway_order_id" TEXT,
    "gateway_payment_id" TEXT,
    "notes" TEXT,
    "paid_at" TIMESTAMP(3),
    "recorded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_no" INTEGER NOT NULL,
    "product_code" TEXT,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "subject" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID,
    "author_name" TEXT NOT NULL,
    "from_saf" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "user_id" UUID,
    "employee_code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "department" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "blood_group" TEXT,
    "emergency_contact" TEXT,
    "date_of_joining" DATE,
    "photo_key" TEXT,
    "product_codes" TEXT[],
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "qr_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "notes" TEXT,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_attendance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "employee_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "shift_id" UUID,
    "date" DATE NOT NULL,
    "check_in_at" TIMESTAMP(3),
    "check_out_at" TIMESTAMP(3),
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "worked_minutes" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'SELF',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_id_cards" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "card_number" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "status" "IdCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "issued_by_id" UUID,
    "product_code" TEXT NOT NULL,

    CONSTRAINT "employee_id_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_tables" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 4,
    "area" TEXT,
    "status" "DineTableStatus" NOT NULL DEFAULT 'FREE',
    "qr_token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dine_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_menu_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "dine_menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_menu_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "tax_rate" INTEGER NOT NULL DEFAULT 500,
    "is_veg" BOOLEAN NOT NULL DEFAULT true,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "prep_minutes" INTEGER NOT NULL DEFAULT 15,
    "stock_item_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dine_menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_no" INTEGER NOT NULL,
    "table_id" UUID,
    "type" "DineOrderType" NOT NULL DEFAULT 'DINE_IN',
    "source" "DineOrderSource" NOT NULL DEFAULT 'POS',
    "status" "DineOrderStatus" NOT NULL DEFAULT 'OPEN',
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "guests" INTEGER NOT NULL DEFAULT 1,
    "waiter_id" UUID,
    "created_by_id" UUID,
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "tax_total" INTEGER NOT NULL DEFAULT 0,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "payment_method" "TenderType",
    "paid_at" TIMESTAMP(3),
    "settled_by_id" UUID,
    "invoice_no" TEXT,
    "public_token" TEXT NOT NULL,
    "notes" TEXT,
    "cancelled_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dine_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_order_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "kot_id" UUID,
    "name" TEXT NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "tax_rate" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "notes" TEXT,
    "status" "DineItemStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dine_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_kitchen_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kot_no" INTEGER NOT NULL,
    "status" "KotStatus" NOT NULL DEFAULT 'NEW',
    "label" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "served_at" TIMESTAMP(3),

    CONSTRAINT "dine_kitchen_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_stock_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "StockKind" NOT NULL DEFAULT 'INGREDIENT',
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reorder_level" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost_per_unit" INTEGER NOT NULL DEFAULT 0,
    "supplier_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dine_stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_recipe_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "dine_recipe_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_stock_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "type" "DineMovementType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "balance_after" DOUBLE PRECISION NOT NULL,
    "reference" TEXT,
    "reason" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dine_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_person" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "gstin" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dine_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_purchases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_no" INTEGER NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'ORDERED',
    "invoice_ref" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "ordered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3),
    "created_by_id" UUID,

    CONSTRAINT "dine_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_purchase_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit_cost" INTEGER NOT NULL,

    CONSTRAINT "dine_purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dine_wastage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "cost_value" INTEGER NOT NULL,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dine_wastage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_room_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "base_rate" INTEGER NOT NULL,
    "max_adults" INTEGER NOT NULL DEFAULT 2,
    "max_children" INTEGER NOT NULL DEFAULT 1,
    "amenities" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stay_room_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_rooms" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "floor" TEXT,
    "status" "RoomStatus" NOT NULL DEFAULT 'AVAILABLE',
    "hk_status" "HousekeepingStatus" NOT NULL DEFAULT 'CLEAN',
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stay_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_guests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "nationality" TEXT DEFAULT 'Indian',
    "id_type" TEXT,
    "id_number" TEXT,
    "company" TEXT,
    "gstin" TEXT,
    "is_vip" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stay_guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "reservation_no" INTEGER NOT NULL,
    "guest_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "room_id" UUID,
    "check_in_date" DATE NOT NULL,
    "check_out_date" DATE NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "rate_per_night" INTEGER NOT NULL,
    "tax_rate" INTEGER NOT NULL DEFAULT 1200,
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "source" TEXT NOT NULL DEFAULT 'WALK_IN',
    "special_requests" TEXT,
    "checked_in_at" TIMESTAMP(3),
    "checked_out_at" TIMESTAMP(3),
    "invoice_no" TEXT,
    "public_token" TEXT NOT NULL,
    "cancelled_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stay_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_folio_charges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "type" "ChargeType" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "tax_rate" INTEGER NOT NULL DEFAULT 0,
    "charge_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "stay_folio_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_folio_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "TenderType" NOT NULL,
    "reference" TEXT,
    "received_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stay_folio_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_expenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "expense_date" DATE NOT NULL,
    "paid_to" TEXT,
    "method" "TenderType" NOT NULL DEFAULT 'CASH',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stay_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_housekeeping_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CLEANING',
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "assigned_to_id" UUID,
    "notes" TEXT,
    "due_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stay_housekeeping_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_maintenance_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "room_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_to_id" UUID,
    "reported_by_id" UUID,
    "room_out_of_order" BOOLEAN NOT NULL DEFAULT false,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "resolution" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stay_maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "bill_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "price" INTEGER NOT NULL,
    "mrp" INTEGER,
    "cost_price" INTEGER NOT NULL DEFAULT 0,
    "tax_rate" INTEGER NOT NULL DEFAULT 0,
    "hsn" TEXT,
    "reorder_level" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bill_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_stock_levels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "bill_stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_stock_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "type" "BillMovementType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "balance_after" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "reference" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_customers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "gstin" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "bill_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_sales" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "counter_id" UUID,
    "sale_no" INTEGER NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "customer_id" UUID,
    "cashier_id" UUID,
    "subtotal" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "tax_total" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "payment_method" "TenderType" NOT NULL,
    "amount_paid" INTEGER NOT NULL,
    "change_due" INTEGER NOT NULL DEFAULT 0,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "void_reason" TEXT,
    "public_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_sale_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "barcode" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "cost_price" INTEGER NOT NULL DEFAULT 0,
    "tax_rate" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "line_total" INTEGER NOT NULL,

    CONSTRAINT "bill_sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_person" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "gstin" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_purchases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "purchase_no" INTEGER NOT NULL,
    "supplier_id" UUID,
    "supplier_name" TEXT,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'RECEIVED',
    "invoice_ref" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "ordered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3),
    "created_by_id" UUID,

    CONSTRAINT "bill_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_purchase_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit_cost" INTEGER NOT NULL,

    CONSTRAINT "bill_purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");

-- CreateIndex
CREATE INDEX "branches_tenant_id_idx" ON "branches"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_code_key" ON "branches"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "plans_product_code_tier_key" ON "plans"("product_code", "tier");

-- CreateIndex
CREATE INDEX "product_subscriptions_current_period_end_idx" ON "product_subscriptions"("current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "product_subscriptions_tenant_id_product_code_key" ON "product_subscriptions"("tenant_id", "product_code");

-- CreateIndex
CREATE INDEX "subscription_events_tenant_id_created_at_idx" ON "subscription_events"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_product_code_code_key" ON "roles"("product_code", "code");

-- CreateIndex
CREATE INDEX "user_product_access_tenant_id_product_code_idx" ON "user_product_access"("tenant_id", "product_code");

-- CreateIndex
CREATE UNIQUE INDEX "user_product_access_user_id_product_code_key" ON "user_product_access"("user_id", "product_code");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_created_at_idx" ON "notifications"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_no_key" ON "invoices"("invoice_no");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_created_at_idx" ON "invoices"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_gateway_order_id_key" ON "payments"("gateway_order_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_created_at_idx" ON "payments"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_tenant_id_ticket_no_key" ON "support_tickets"("tenant_id", "ticket_no");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_user_id_key" ON "employee_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_qr_token_key" ON "employee_profiles"("qr_token");

-- CreateIndex
CREATE INDEX "employee_profiles_tenant_id_idx" ON "employee_profiles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_tenant_id_employee_code_key" ON "employee_profiles"("tenant_id", "employee_code");

-- CreateIndex
CREATE INDEX "staff_shifts_tenant_id_product_code_idx" ON "staff_shifts"("tenant_id", "product_code");

-- CreateIndex
CREATE INDEX "shift_assignments_tenant_id_date_idx" ON "shift_assignments"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "shift_assignments_employee_id_date_key" ON "shift_assignments"("employee_id", "date");

-- CreateIndex
CREATE INDEX "staff_attendance_tenant_id_date_idx" ON "staff_attendance"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_employee_id_date_key" ON "staff_attendance"("employee_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_id_cards_tenant_id_card_number_key" ON "employee_id_cards"("tenant_id", "card_number");

-- CreateIndex
CREATE UNIQUE INDEX "dine_tables_qr_token_key" ON "dine_tables"("qr_token");

-- CreateIndex
CREATE UNIQUE INDEX "dine_tables_tenant_id_branch_id_name_key" ON "dine_tables"("tenant_id", "branch_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "dine_menu_categories_tenant_id_name_key" ON "dine_menu_categories"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "dine_menu_items_tenant_id_category_id_idx" ON "dine_menu_items"("tenant_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "dine_orders_public_token_key" ON "dine_orders"("public_token");

-- CreateIndex
CREATE INDEX "dine_orders_tenant_id_status_idx" ON "dine_orders"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "dine_orders_tenant_id_created_at_idx" ON "dine_orders"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dine_orders_tenant_id_order_no_key" ON "dine_orders"("tenant_id", "order_no");

-- CreateIndex
CREATE INDEX "dine_order_items_order_id_idx" ON "dine_order_items"("order_id");

-- CreateIndex
CREATE INDEX "dine_kitchen_orders_tenant_id_status_idx" ON "dine_kitchen_orders"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dine_stock_items_tenant_id_name_key" ON "dine_stock_items"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "dine_recipe_items_menu_item_id_stock_item_id_key" ON "dine_recipe_items"("menu_item_id", "stock_item_id");

-- CreateIndex
CREATE INDEX "dine_stock_movements_tenant_id_created_at_idx" ON "dine_stock_movements"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dine_purchases_tenant_id_purchase_no_key" ON "dine_purchases"("tenant_id", "purchase_no");

-- CreateIndex
CREATE INDEX "dine_wastage_tenant_id_created_at_idx" ON "dine_wastage"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stay_room_types_tenant_id_name_key" ON "stay_room_types"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "stay_rooms_tenant_id_branch_id_number_key" ON "stay_rooms"("tenant_id", "branch_id", "number");

-- CreateIndex
CREATE INDEX "stay_guests_tenant_id_phone_idx" ON "stay_guests"("tenant_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "stay_reservations_public_token_key" ON "stay_reservations"("public_token");

-- CreateIndex
CREATE INDEX "stay_reservations_tenant_id_check_in_date_check_out_date_idx" ON "stay_reservations"("tenant_id", "check_in_date", "check_out_date");

-- CreateIndex
CREATE INDEX "stay_reservations_tenant_id_status_idx" ON "stay_reservations"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stay_reservations_tenant_id_reservation_no_key" ON "stay_reservations"("tenant_id", "reservation_no");

-- CreateIndex
CREATE INDEX "stay_folio_payments_tenant_id_created_at_idx" ON "stay_folio_payments"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "stay_expenses_tenant_id_expense_date_idx" ON "stay_expenses"("tenant_id", "expense_date");

-- CreateIndex
CREATE INDEX "stay_housekeeping_tasks_tenant_id_status_idx" ON "stay_housekeeping_tasks"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "stay_maintenance_records_tenant_id_status_idx" ON "stay_maintenance_records"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bill_categories_tenant_id_name_key" ON "bill_categories"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bill_products_tenant_id_sku_key" ON "bill_products"("tenant_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "bill_products_tenant_id_barcode_key" ON "bill_products"("tenant_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "bill_stock_levels_product_id_branch_id_key" ON "bill_stock_levels"("product_id", "branch_id");

-- CreateIndex
CREATE INDEX "bill_stock_movements_tenant_id_created_at_idx" ON "bill_stock_movements"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bill_customers_tenant_id_phone_key" ON "bill_customers"("tenant_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "bill_counters_tenant_id_branch_id_name_key" ON "bill_counters"("tenant_id", "branch_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bill_sales_public_token_key" ON "bill_sales"("public_token");

-- CreateIndex
CREATE INDEX "bill_sales_tenant_id_created_at_idx" ON "bill_sales"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bill_sales_tenant_id_sale_no_key" ON "bill_sales"("tenant_id", "sale_no");

-- CreateIndex
CREATE INDEX "bill_sale_items_sale_id_idx" ON "bill_sale_items"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_purchases_tenant_id_purchase_no_key" ON "bill_purchases"("tenant_id", "purchase_no");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_product_code_fkey" FOREIGN KEY ("product_code") REFERENCES "products"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_catalog" ADD CONSTRAINT "feature_catalog_product_code_fkey" FOREIGN KEY ("product_code") REFERENCES "products"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "feature_catalog"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "feature_catalog"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_subscriptions" ADD CONSTRAINT "product_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_subscriptions" ADD CONSTRAINT "product_subscriptions_product_code_fkey" FOREIGN KEY ("product_code") REFERENCES "products"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_subscriptions" ADD CONSTRAINT "product_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_subscriptions" ADD CONSTRAINT "product_subscriptions_pending_plan_id_fkey" FOREIGN KEY ("pending_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "product_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_product_settings" ADD CONSTRAINT "tenant_product_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_sequences" ADD CONSTRAINT "doc_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_product_access" ADD CONSTRAINT "user_product_access_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_product_access" ADD CONSTRAINT "user_product_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_product_access" ADD CONSTRAINT "user_product_access_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "product_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "product_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "staff_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "staff_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_id_cards" ADD CONSTRAINT "employee_id_cards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_id_cards" ADD CONSTRAINT "employee_id_cards_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_tables" ADD CONSTRAINT "dine_tables_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_tables" ADD CONSTRAINT "dine_tables_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_menu_categories" ADD CONSTRAINT "dine_menu_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_menu_items" ADD CONSTRAINT "dine_menu_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_menu_items" ADD CONSTRAINT "dine_menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "dine_menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_menu_items" ADD CONSTRAINT "dine_menu_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "dine_stock_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_orders" ADD CONSTRAINT "dine_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_orders" ADD CONSTRAINT "dine_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_orders" ADD CONSTRAINT "dine_orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "dine_tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_orders" ADD CONSTRAINT "dine_orders_waiter_id_fkey" FOREIGN KEY ("waiter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_order_items" ADD CONSTRAINT "dine_order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_order_items" ADD CONSTRAINT "dine_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "dine_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_order_items" ADD CONSTRAINT "dine_order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "dine_menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_order_items" ADD CONSTRAINT "dine_order_items_kot_id_fkey" FOREIGN KEY ("kot_id") REFERENCES "dine_kitchen_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_kitchen_orders" ADD CONSTRAINT "dine_kitchen_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_kitchen_orders" ADD CONSTRAINT "dine_kitchen_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "dine_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_stock_items" ADD CONSTRAINT "dine_stock_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_stock_items" ADD CONSTRAINT "dine_stock_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "dine_suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_recipe_items" ADD CONSTRAINT "dine_recipe_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_recipe_items" ADD CONSTRAINT "dine_recipe_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "dine_menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_recipe_items" ADD CONSTRAINT "dine_recipe_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "dine_stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_stock_movements" ADD CONSTRAINT "dine_stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_stock_movements" ADD CONSTRAINT "dine_stock_movements_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "dine_stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_suppliers" ADD CONSTRAINT "dine_suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_purchases" ADD CONSTRAINT "dine_purchases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_purchases" ADD CONSTRAINT "dine_purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "dine_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_purchase_items" ADD CONSTRAINT "dine_purchase_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_purchase_items" ADD CONSTRAINT "dine_purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "dine_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_purchase_items" ADD CONSTRAINT "dine_purchase_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "dine_stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_wastage" ADD CONSTRAINT "dine_wastage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dine_wastage" ADD CONSTRAINT "dine_wastage_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "dine_stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_room_types" ADD CONSTRAINT "stay_room_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_rooms" ADD CONSTRAINT "stay_rooms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_rooms" ADD CONSTRAINT "stay_rooms_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_rooms" ADD CONSTRAINT "stay_rooms_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "stay_room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_guests" ADD CONSTRAINT "stay_guests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_reservations" ADD CONSTRAINT "stay_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_reservations" ADD CONSTRAINT "stay_reservations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_reservations" ADD CONSTRAINT "stay_reservations_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "stay_guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_reservations" ADD CONSTRAINT "stay_reservations_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "stay_room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_reservations" ADD CONSTRAINT "stay_reservations_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "stay_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_folio_charges" ADD CONSTRAINT "stay_folio_charges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_folio_charges" ADD CONSTRAINT "stay_folio_charges_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "stay_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_folio_payments" ADD CONSTRAINT "stay_folio_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_folio_payments" ADD CONSTRAINT "stay_folio_payments_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "stay_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_expenses" ADD CONSTRAINT "stay_expenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_housekeeping_tasks" ADD CONSTRAINT "stay_housekeeping_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_housekeeping_tasks" ADD CONSTRAINT "stay_housekeeping_tasks_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "stay_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_housekeeping_tasks" ADD CONSTRAINT "stay_housekeeping_tasks_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_maintenance_records" ADD CONSTRAINT "stay_maintenance_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_maintenance_records" ADD CONSTRAINT "stay_maintenance_records_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "stay_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_maintenance_records" ADD CONSTRAINT "stay_maintenance_records_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_categories" ADD CONSTRAINT "bill_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_products" ADD CONSTRAINT "bill_products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_products" ADD CONSTRAINT "bill_products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "bill_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_stock_levels" ADD CONSTRAINT "bill_stock_levels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_stock_levels" ADD CONSTRAINT "bill_stock_levels_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "bill_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_stock_levels" ADD CONSTRAINT "bill_stock_levels_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_stock_movements" ADD CONSTRAINT "bill_stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_stock_movements" ADD CONSTRAINT "bill_stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "bill_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_customers" ADD CONSTRAINT "bill_customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_counters" ADD CONSTRAINT "bill_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_counters" ADD CONSTRAINT "bill_counters_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_sales" ADD CONSTRAINT "bill_sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_sales" ADD CONSTRAINT "bill_sales_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_sales" ADD CONSTRAINT "bill_sales_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "bill_counters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_sales" ADD CONSTRAINT "bill_sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "bill_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_sales" ADD CONSTRAINT "bill_sales_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_sale_items" ADD CONSTRAINT "bill_sale_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_sale_items" ADD CONSTRAINT "bill_sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "bill_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_sale_items" ADD CONSTRAINT "bill_sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "bill_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_suppliers" ADD CONSTRAINT "bill_suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_purchases" ADD CONSTRAINT "bill_purchases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_purchases" ADD CONSTRAINT "bill_purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "bill_suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_purchase_items" ADD CONSTRAINT "bill_purchase_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_purchase_items" ADD CONSTRAINT "bill_purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "bill_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_purchase_items" ADD CONSTRAINT "bill_purchase_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "bill_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
