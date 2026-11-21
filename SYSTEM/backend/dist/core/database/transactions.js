import { getPrismaClient } from "./prisma.js";
export const dbTransaction = ((...args) => {
    return getPrismaClient().$transaction(...args);
});
