/* eslint-disable */

import { default as dotenv } from 'dotenv'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront'
import fs from 'fs'
import path from 'path'

dotenv.config()

const s3Client = new S3Client({ region: 'us-west-2' })
const cfClient = new CloudFrontClient({ region: 'us-west-2' })

const root = 'packages/web'
const { version } = JSON.parse(fs.readFileSync(`${root}/package.json`))

const files = fs.readdirSync(`${root}/dist/artifacts`)
for (const file of files) {
  const data = fs.readFileSync(`${root}/dist/artifacts/${file}`)
  const fileName = `rum/js/v${version}/${file}`
  const ext = path.extname(file)

  console.log(`Uploading ${fileName}...`)
  s3Client.send(
    new PutObjectCommand({
      Body: data,
      Bucket: process.env.BUCKET_NAME,
      Key: fileName,
      ContentType: ext === 'js' && 'text/javascript',
    })
  )
}

console.log('Invalidating cache...')
const invalidationRef = `rum-${new Date().toISOString()}`
cfClient.send(
  new CreateInvalidationCommand({
    DistributionId: process.env.CDN_DISTRIBUTION_ID,
    InvalidationBatch: {
      CallerReference: invalidationRef,
      Paths: {
        Items: ['/rum/*'],
        Quantity: 1,
      },
    },
  })
)
