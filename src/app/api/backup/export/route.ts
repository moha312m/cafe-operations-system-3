import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession, ApiError, handleApiError } from "@/lib/api";
import { db } from "@/lib/db";
import {
  checkOwnerOverrideCode,
  overrideCodeFrom,
  OWNER_OVERRIDE_REFUSED,
  OWNER_OVERRIDE_LOCKED,
} from "@/lib/owner-override";
import {
  fetchAllCafeData,
  serializeBackupToSql,
  serializeBackupToJson,
  getBackupStatus,
  recordBackupAudit,
} from "@/lib/backup/export";

async function executeBackupExport(request: NextRequest) {
  const session = await requireActiveSession();
  if (session.role !== "CAFE_OWNER" || !session.cafeId) {
    throw new ApiError(403, "صلاحية مالك الكافيه مطلوبة لتصدير النسخة الاحتياطية");
  }

  const code = overrideCodeFrom(request);
  if (!code) {
    throw new ApiError(400, "رمز موافقة المالك مطلوب لتنزيل النسخة الاحتياطية");
  }

  const check = await checkOwnerOverrideCode(session, {
    branchId: session.branchId ?? "",
    code,
  });

  if (check.status === "INVALID" || check.status === "NONE") {
    throw new ApiError(403, OWNER_OVERRIDE_REFUSED);
  }
  if (check.status === "LOCKED") {
    throw new ApiError(429, OWNER_OVERRIDE_LOCKED);
  }

  // Record successful passcode attempt
  await db.ownerPasscodeAttempt.create({
    data: {
      cafeId: check.grant.cafeId,
      ownerId: check.grant.ownerId,
      passcodeId: check.grant.passcodeId,
      requesterId: session.id,
      success: true,
    },
  });

  const data = await fetchAllCafeData(session.cafeId, session);
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "127.0.0.1";

  const requestedFormat = request.nextUrl.searchParams.get("format") === "json" ? "json" : "sql";

  await recordBackupAudit(session, {
    ipAddress,
    format: requestedFormat,
    tableCounts: data.manifest.tableCounts,
    totalRows: data.manifest.totalRows,
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  const cafeSlug = data.manifest.cafeSlug || "cafe";

  if (requestedFormat === "json") {
    const jsonContent = serializeBackupToJson(data);
    const filename = `nextcup-backup-${cafeSlug}-${dateStr}.json`;
    return new Response(jsonContent, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store, private",
      },
    });
  }

  const sqlContent = serializeBackupToSql(data);
  const filename = `nextcup-backup-${cafeSlug}-${dateStr}.sql`;
  return new Response(sqlContent, {
    status: 200,
    headers: {
      "Content-Type": "application/sql; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, private",
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get("status") === "true") {
      const session = await requireActiveSession();
      if (session.role !== "CAFE_OWNER" || !session.cafeId) {
        throw new ApiError(403, "صلاحية مالك الكافيه مطلوبة");
      }
      const status = await getBackupStatus(session.cafeId);
      return NextResponse.json(status);
    }

    return await executeBackupExport(request);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    return await executeBackupExport(request);
  } catch (error) {
    return handleApiError(error);
  }
}
