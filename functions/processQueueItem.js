"use strict";

const AWS = require("aws-sdk");
const S3 = new AWS.S3({ apiVersion: "2006-03-01" });
const SES = new AWS.SES({ apiVersion: "2010-12-01" });
const documentClient = new AWS.DynamoDB.DocumentClient();
const request = require("request-promise-native");
const { RATE_LIMIT, RATE_PERIOD, RATE_WAIT } = require("../lib/constants");
const Metrics = require("../lib/metrics");

exports.handler = async function({ Records }, context) {
  console.log("Received", Records.length, "messages to process");
  const results = [];
  for (let idx = 0; idx < Records.length; idx++) {
    const result = await exports.handleOne(Records[idx], context);
    results.push(result);
  }
  console.log("Finished processing batch of", results.length, "messages");
  return results;
};

const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
const epochNow = () => Math.floor(Date.now() / 1000);

const emailSubject = ({ id, user }) =>
  `[watchdog-proxy] Positive match for ${user} (${id})`;

const emailBody = ({
  id,
  datestamp,
  user,
  notes,
  imageUrl,
  requestUrl,
  responseUrl,
  expirationDate,
  upstreamServiceResponse
}) => `
Watchdog ID:
${id}

Client application:
${user}

Datestamp:
${datestamp}

Notes:
${notes}

Match metadata:
${JSON.stringify(upstreamServiceResponse, null, " ")}

NOTE: The following URLs will expire and stop working after ${expirationDate}.

Image URL:
${imageUrl}

Request JSON:
${requestUrl}

Response JSON:
${responseUrl}
`;

exports.handleOne = async function({ receiptHandle, body }, { awsRequestId }) {
  const {
    HITRATE_TABLE,
    CONTENT_BUCKET: Bucket,
    UPSTREAM_SERVICE_KEY,
    EMAIL_FROM,
    EMAIL_TO,
    EMAIL_EXPIRES
  } = process.env;

  const {
    datestamp,
    upstreamServiceUrl,
    id,
    user,
    negative_uri,
    positive_uri,
    positive_email,
    notes,
    image
  } = JSON.parse(body);

  // Start constructing metrics ping data here, so that if there are any
  // exceptions we can at least send out a partially filled-in ping with
  // is_error: true
  const metricsPing = {
    consumer_name: user,
    worker_id: awsRequestId,
    watchdog_id: id,
    photodna_tracking_id: null,
    is_match: false,
    is_error: false,
    timing_sent: null,
    timing_received: null,
    timing_submitted: null
  };

  console.log("Processing queue item", id);

  try {
    // Pause if we're at the rate limit for current expiration window
    let rateLimited = false;
    do {
      const data = await documentClient
        .scan({
          TableName: HITRATE_TABLE,
          FilterExpression: "expiresAt > :now",
          ExpressionAttributeValues: { ":now": epochNow() }
        })
        .promise();
      if (data.Count >= RATE_LIMIT) {
        console.log("Pausing for rate limit", epochNow());
        rateLimited = true;
        await wait(RATE_WAIT);
      } else {
        rateLimited = false;
      }
    } while (rateLimited);

    // Count the current request in hitrate
    await documentClient
      .put({
        TableName: HITRATE_TABLE,
        Item: {
          id,
          timestamp: epochNow(),
          expiresAt: epochNow() + Math.floor(RATE_PERIOD / 1000)
        }
      })
      .promise();

    const imageUrl = S3.getSignedUrl("getObject", {
      Bucket,
      Key: image
    });

    metricsPing.timing_sent = Date.now() - Date.parse(datestamp);

    const timingReceivedStart = Date.now();
    const upstreamServiceResponse = await request.post({
      url: `${upstreamServiceUrl}?enhance`,
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": UPSTREAM_SERVICE_KEY
      },
      json: true,
      body: {
        DataRepresentation: "URL",
        Value: imageUrl
      }
    });
    metricsPing.timing_received = Date.now() - timingReceivedStart;
    metricsPing.photodna_tracking_id = upstreamServiceResponse.TrackingId;

    const { IsMatch } = upstreamServiceResponse;
    metricsPing.is_match = IsMatch;

    if (!IsMatch) {
      // On negative match, clean up the image and request details.
      await Promise.all([
        S3.deleteObject({ Bucket, Key: `${image}` }).promise(),
        S3.deleteObject({ Bucket, Key: `${image}-request.json` }).promise()
      ]);
    } else {
      // On positive match, store the details of the match response.
      await S3.putObject({
        Bucket,
        Key: `${image}-response.json`,
        ContentType: "application/json",
        Body: JSON.stringify({
          id,
          user,
          negative_uri,
          positive_uri,
          positive_email,
          notes,
          image,
          response: upstreamServiceResponse
        })
      }).promise();

      // Send an email alert on positive match, if addresses are available.
      const ToAddresses = [];
      if (positive_email) {
        ToAddresses.push(positive_email);
      }
      if (EMAIL_TO) {
        ToAddresses.push(EMAIL_TO);
      }
      if (EMAIL_FROM && ToAddresses.length) {
        const commonUrlParams = {
          Bucket,
          Expires: parseInt(EMAIL_EXPIRES, 10) || 60 * 60 * 24 * 30
        };
        const imageUrl = S3.getSignedUrl(
          "getObject",
          Object.assign({ Key: image }, commonUrlParams)
        );
        const requestUrl = S3.getSignedUrl(
          "getObject",
          Object.assign({ Key: `${image}-request.json` }, commonUrlParams)
        );
        const responseUrl = S3.getSignedUrl(
          "getObject",
          Object.assign({ Key: `${image}-response.json` }, commonUrlParams)
        );
        const expirationDate = new Date(
          Date.now() + parseInt(EMAIL_EXPIRES) * 1000
        ).toISOString();
        const emailParams = {
          Source: EMAIL_FROM,
          Destination: { ToAddresses },
          Message: {
            Subject: {
              Charset: "UTF-8",
              Data: emailSubject({ id, user })
            },
            Body: {
              Text: {
                Charset: "UTF-8",
                Data: emailBody({
                  id,
                  datestamp,
                  user,
                  notes,
                  imageUrl,
                  requestUrl,
                  responseUrl,
                  expirationDate,
                  upstreamServiceResponse
                })
              }
            }
          }
        };
        const emailResult = await SES.sendEmail(emailParams).promise();
        console.log(`Sent notification email (${emailResult.MessageId})`);
      }
    }

    const timingSubmittedStart = Date.now();
    await request.post({
      url: IsMatch ? positive_uri : negative_uri,
      headers: {
        "Content-Type": "application/json"
      },
      json: true,
      body: {
        watchdog_id: id,
        positive: upstreamServiceResponse.IsMatch
      }
    });
    metricsPing.timing_submitted = Date.now() - timingSubmittedStart;
  } catch (err) {
    metricsPing.is_error = true;
    console.log("REQUEST ERROR", err);
    throw err;
  }

  await Metrics.workerWorks(metricsPing);
  return id;
};
