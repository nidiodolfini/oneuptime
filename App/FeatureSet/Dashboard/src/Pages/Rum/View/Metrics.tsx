import PageComponentProps from "../../PageComponentProps";
import ObjectID from "Common/Types/ObjectID";
import Navigation from "Common/UI/Utils/Navigation";
import RumApplication from "Common/Models/DatabaseModels/RumApplication";
import React, {
  Fragment,
  FunctionComponent,
  ReactElement,
  useEffect,
  useState,
} from "react";
import ModelAPI from "Common/UI/Utils/ModelAPI/ModelAPI";
import API from "Common/UI/Utils/API/API";
import PageLoader from "Common/UI/Components/Loader/PageLoader";
import ErrorMessage from "Common/UI/Components/ErrorMessage/ErrorMessage";
import { PromiseVoidFunction } from "Common/Types/FunctionTypes";
import MetricsViewer from "../../../Components/Metrics/MetricsViewer";
import ProjectUtil from "Common/UI/Utils/Project";
import { keyForService } from "Common/Utils/Telemetry/EntityKey";

const RumApplicationMetrics: FunctionComponent<
  PageComponentProps
> = (): ReactElement => {
  const modelId: ObjectID = Navigation.getLastParamAsObjectID(1);

  const [rumApplication, setRumApplication] = useState<RumApplication | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  const fetchData: PromiseVoidFunction = async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    try {
      const item: RumApplication | null = await ModelAPI.getItem({
        modelType: RumApplication,
        id: modelId,
        select: {
          appIdentifier: true,
          name: true,
        },
      });

      if (!item?.appIdentifier) {
        setError("RUM application not found.");
        setIsLoading(false);
        return;
      }

      setRumApplication(item);
    } catch (err) {
      setError(API.getFriendlyMessage(err));
    }
    setIsLoading(false);
  };

  useEffect(() => {
    fetchData().catch((err: Error) => {
      setError(API.getFriendlyMessage(err));
    });
  }, []);

  if (isLoading) {
    return <PageLoader isVisible={true} />;
  }

  if (error) {
    return <ErrorMessage message={error} />;
  }

  if (!rumApplication?.appIdentifier) {
    return <ErrorMessage message="RUM application not found." />;
  }

  const appIdentifier: string = rumApplication.appIdentifier;
  const projectId: ObjectID | null = ProjectUtil.getCurrentProjectId();

  if (!projectId) {
    return <ErrorMessage message="Project not found." />;
  }

  /*
   * Metricas de RUM tem primaryEntityId = RumApplication, entao o filtro
   * `serviceIds` do MetricsViewer — que vira join com a relacao
   * MetricType.services (ManyToMany com Service, Postgres) — NUNCA casa
   * (o id e de RumApplication, nao de Service; lista vinha vazia com o
   * ClickHouse cheio de web_vital.*). Escopo correto e o do proprio sinal:
   * o ingest carimba `entityKeys` com a identidade de SERVICE derivada do
   * resource service.name (= appIdentifier) — keyForService reproduz a
   * chave byte a byte (mesmo preimage do ingest) — e o fallback C4 cobre
   * linhas pre-backfill via attributes['resource.service.name'].
   * Mesma familia do fix .9 (traces list resolve RumApplications).
   */
  return (
    <Fragment>
      <MetricsViewer
        entityScope={{
          entityKeys: [keyForService(projectId.toString(), appIdentifier)],
          attributeKey: "resource.service.name",
          attributeValue: appIdentifier,
        }}
      />
    </Fragment>
  );
};

export default RumApplicationMetrics;
