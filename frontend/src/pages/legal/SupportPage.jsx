import { Link } from "react-router-dom";

import { LegalPage, Section, P, UL } from "./LegalLayout.jsx";

// Support / contact page. Public, like Terms and Privacy, because it is the
// "Support URL" on the App Store listing: Apple requires that URL to reach a
// page with real contact details, and App Review opens it logged out. Keep the
// contact address the same one the legal pages use.
const CONTACT = "timeline.support@icloud.com";

export default function SupportPage() {
  return (
    <LegalPage title="Help & support">
      <Section heading="Getting in touch">
        <P>
          TimeLine is run by one person, not a company. For help with your
          account, a problem with the app or the website, or anything else,
          email{" "}
          <a href={`mailto:${CONTACT}`} className="font-medium text-accent-deep hover:underline">
            {CONTACT}
          </a>
          . We read every message and usually reply within a few days.
        </P>
      </Section>

      <Section heading="Getting an account">
        <P>
          Create an account on the{" "}
          <Link to="/signup" className="font-medium text-accent-deep hover:underline">
            sign-up page
          </Link>
          , confirm your email address, then log in on the website or in the
          iPhone app. New accounts are checked by hand before they can log in,
          so it can take a little while.
        </P>
      </Section>

      <Section heading="Reporting something">
        <P>
          To report a post, comment or message that shouldn’t be on TimeLine,
          use <strong>Report</strong> in its ⋯ menu. To stop someone contacting
          you, open their profile and choose <strong>Block</strong>. You can also
          email us about anything you’d rather not report in the app.
        </P>
      </Section>

      <Section heading="Your data">
        <UL>
          <li>
            Delete your account at any time from <strong>Settings → Delete
            account</strong>, in the app or on the website.
          </li>
          <li>
            How we handle your data is set out in the{" "}
            <Link to="/privacy" className="font-medium text-accent-deep hover:underline">
              Privacy Policy
            </Link>
            .
          </li>
        </UL>
      </Section>
    </LegalPage>
  );
}
