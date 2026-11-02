CREATE TABLE "support_request_read" (
    "requestId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_request_read_pkey" PRIMARY KEY ("requestId", "userId")
);

ALTER TABLE "support_request_read" ADD CONSTRAINT "support_request_read_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "support_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_request_read" ADD CONSTRAINT "support_request_read_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
