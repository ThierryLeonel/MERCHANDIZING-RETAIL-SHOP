import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class PageQuery {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ default: 25, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 25;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sort?: string;
  @ApiPropertyOptional({ enum: ["asc", "desc"] }) @IsOptional() @IsIn(["asc", "desc"]) order: "asc" | "desc" = "desc";
}

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

export function pageArgs(q: PageQuery) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}
/** Returns a Prisma orderBy for an allow-listed sort field. */
export function orderBy(q: PageQuery, allowed: string[], fallback: string) {
  const field = q.sort && allowed.includes(q.sort) ? q.sort : fallback;
  return { [field]: q.order ?? "desc" };
}
export async function paginate<T>(q: PageQuery, count: Promise<number>, items: Promise<T[]>): Promise<Page<T>> {
  const [total, rows] = await Promise.all([count, items]);
  return { items: rows, total, page: q.page, pageSize: q.pageSize };
}
