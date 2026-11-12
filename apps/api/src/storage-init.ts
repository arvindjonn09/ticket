import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { setTimeout } from "node:timers/promises";
if (
  !process.env.S3_ENDPOINT ||
  !process.env.S3_ACCESS_KEY ||
  !process.env.S3_SECRET_KEY ||
  !process.env.S3_BUCKET
)
  throw new Error("Storage configuration required");
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});
for (let attempt = 0; ; attempt++) {
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404)
        throw error;
      await client.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
    }
    break;
  } catch (error) {
    if (attempt === 19) throw error;
    await setTimeout(1000);
  }
}
client.destroy();
console.info("Private attachment bucket ready");
