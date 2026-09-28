import nodemailer from "nodemailer";
import { config } from "../config.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;

/** In development (no SMTP_URL) messages are printed so verification links can be copied from the console. */
export async function sendMail(mail: Mail): Promise<void> {
  if (!transport) {
    console.log(`\n[mail:dev] to=${mail.to}\nsubject=${mail.subject}\n${mail.text}\n`);
    return;
  }
  await transport.sendMail({ from: config.MAIL_FROM, ...mail });
}
