import NotificationPreferencesSection from "../components/NotificationPreferencesSection.jsx";
import ChangePasswordSection from "../components/ChangePasswordSection.jsx";
import DeleteAccountSection from "../components/DeleteAccountSection.jsx";

// Account & security controls, at /settings. Profile editing (name, bio, avatar)
// used to live here too, but that's public-facing info you edit in place on your
// own profile now (issue #53) — Settings holds only the account-level controls,
// and is the home for future ones (notification prefs, password, deletion).
export default function SettingsPage() {
  return (
    <div className="px-5 py-7">
      <h1 className="mb-6 font-display text-2xl font-bold -tracking-[0.02em] text-ink">
        Settings
      </h1>

      <NotificationPreferencesSection />

      <ChangePasswordSection />

      <DeleteAccountSection />
    </div>
  );
}
