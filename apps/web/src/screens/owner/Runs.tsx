import { FileCheck2 } from "lucide-react";
import { api } from "../../api/client";
import { EmptyState, ErrorState, Header, ListSkeleton, Page } from "../../components/ui";
import { useI18n } from "../../i18n";
import { useResource } from "../../lib/resource";
import { RunList } from "./Dashboard";

export default function Runs() {
  const { t, lang } = useI18n();
  const res = useResource("runs:list", () => api.runs());
  return (
    <>
      <Header title={t("runs.title")} back="/pay" />
      <Page>
        {res.error && !res.data ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : !res.data ? (
          <ListSkeleton rows={4} />
        ) : res.data.length === 0 ? (
          <EmptyState icon={FileCheck2} title={t("runs.empty")} />
        ) : (
          <RunList runs={res.data} lang={lang} />
        )}
      </Page>
    </>
  );
}
