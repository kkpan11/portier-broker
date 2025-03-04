// Starts a broker with a minimal config.

import crypto from "crypto";
import path from "path";
import readline from "readline";
import { Mailbox } from "./mailbox";
import { connect } from "node:net";
import { setTimeout } from "node:timers/promises";
import { spawn } from "child_process";

import {
  PORTIER_BIN,
  RUST_LOG,
  TEST_STORE,
  TEST_KEY_MANAGER,
  TEST_MAILER,
} from "./env";

const ROOT = path.resolve(__dirname, "../../../");
const BIN = path.resolve(ROOT, PORTIER_BIN);

export interface Broker {
  destroy(): void;
}

export default async ({ mailbox }: { mailbox: Mailbox }): Promise<Broker> => {
  const env: { [key: string]: string } = {
    RUST_LOG,
    RUST_BACKTRACE: "1",
    // TODO: On Linux, localhost sometimes resolves to IPv6, but the broker
    // listens on IPv4 by default. This issue is probably broader than Linux,
    // and a better solution is if we could simply specify 'localhost' in
    // broker config, then have it bind to all addresses.
    BROKER_LISTEN_IP: process.platform === "linux" ? "::1" : "127.0.0.1",
    BROKER_LISTEN_PORT: "44133",
    BROKER_PUBLIC_URL: "http://localhost:44133",
    BROKER_FROM_ADDRESS: "portier@example.com",
    BROKER_LIMITS: "100000/s",
    BROKER_ALLOWED_DOMAINS: "example.com",
  };

  switch (TEST_STORE) {
    case "memory":
      env.BROKER_MEMORY_STORAGE = "true";
      break;
    case "redis":
      // TODO: The Redis client does not try all addresses for `localhost`, and
      // Docker only does IPv4 port forwards, so `localhost` fails trying IPv6
      // first on GitHub Actions. For now, we force IPv4 here.
      env.BROKER_REDIS_URL = "redis://127.0.0.1/0";
      break;
    case "sqlite":
      const id = String(Math.random()).slice(2);
      env.BROKER_SQLITE_DB = `/tmp/portier-broker-test-${id}.sqlite3`;
      break;
    default:
      throw Error(`Invalid TEST_STORE: ${TEST_STORE}`);
  }

  switch (TEST_KEY_MANAGER) {
    case "rotating":
      break;
    case "manual":
      const { privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      env.BROKER_KEYTEXT = privateKey
        .export({
          type: "pkcs8",
          format: "pem",
        })
        .toString();
      break;
    default:
      throw Error(`Invalid TEST_KEY_MANAGER: ${TEST_KEY_MANAGER}`);
  }

  switch (TEST_MAILER) {
    case "smtp":
      env.BROKER_SMTP_SERVER = "localhost:44125";
      break;
    case "sendmail":
      env.BROKER_SENDMAIL_COMMAND = `${__dirname}/sendmail.sh`;
      break;
    case "postmark":
      env.BROKER_POSTMARK_TOKEN = "POSTMARK_API_TEST";
      env.BROKER_POSTMARK_API = "http://localhost:44920/postmark";
      break;
    case "mailgun":
      env.BROKER_MAILGUN_API = "http://localhost:44920/mailgun";
      env.BROKER_MAILGUN_TOKEN = "123";
      env.BROKER_MAILGUN_DOMAIN = "portier.io";
      break;
    case "sendgrid":
      env.BROKER_SENDGRID_TOKEN = "SENDGRID_API_TEST";
      env.BROKER_SENDGRID_API = "http://localhost:44920/sendgrid";
      break;
    default:
      throw Error(`Invalid TEST_MAILER: ${TEST_MAILER}`);
  }

  const subprocess = spawn(BIN, [], {
    stdio: ["ignore", "inherit", "pipe"],
    cwd: ROOT,
    env,
  });

  // Parse output appearing on broker stderr.
  // This is produced by `sendmail.sh` or the Postmark code in the broker.
  let inMail = false;
  let mailBuffer = "";
  readline
    .createInterface({
      input: subprocess.stderr,
      crlfDelay: Infinity,
    })
    .on("line", (line: string) => {
      switch (line) {
        case "-----BEGIN EMAIL TEXT BODY-----":
          inMail = true;
          mailBuffer = "";
          break;

        case "-----END EMAIL TEXT BODY-----": {
          const mail = mailBuffer;
          inMail = false;
          mailBuffer = "";
          if (mail) {
            mailbox.pushMail(mail);
          }
          break;
        }

        default:
          if (inMail) {
            mailBuffer += `${line}\n`;
          } else {
            process.stderr.write(`${line}\n`);
          }
          break;
      }
    });

  // Wait for broker to start.
  let err = "unknown";
  for (let i = 20; i--; err && i) {
    err = await new Promise((resolve) => {
      const sock = connect(44133, env.BROKER_LISTEN_IP)
        .on("error", (err) => {
          resolve(err.message);
        })
        .on("connect", () => {
          sock.destroy();
          resolve("");
        });
    });
    err && (await setTimeout(500));
  }
  if (err) {
    subprocess.kill();
    throw Error("Could not start broker: " + err);
  }

  return {
    destroy() {
      subprocess.kill();
    },
  };
};
