import * as Prisma from "@prisma/client";
import type { DBSchema } from "idb";

export interface PrismaIDBSchema extends DBSchema {
  User: {
    key: [id: Prisma.User["id"]];
    value: Prisma.User;
  };
  Profile: {
    key: [id: Prisma.Profile["id"]];
    value: Prisma.Profile;
    indexes: {
      userIdIndex: [userId: Prisma.Profile["userId"]];
    };
  };
  Post: {
    key: [id: Prisma.Post["id"]];
    value: Prisma.Post;
  };
  Comment: {
    key: [id: Prisma.Comment["id"]];
    value: Prisma.Comment;
  };
  AllFieldScalarTypes: {
    key: [id: Prisma.AllFieldScalarTypes["id"]];
    value: Prisma.AllFieldScalarTypes;
  };
}
