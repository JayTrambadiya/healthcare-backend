import { S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-south-1" });

export const BUCKET_NAME = process.env.S3_BUCKET_NAME;

export const S3_PREFIX = {
    UPLOADS: "uploads/",
    MRF_FILES: "public/mrf-files/",
};