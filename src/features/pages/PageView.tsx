import { Component, memo, useEffect, type ReactNode } from "react";
import type { PageProps, RegisteredPage } from "./service";

type BoundaryProps = {
  children: ReactNode;
  page: RegisteredPage;
  navigation?: PageProps["navigation"];
};
class PageBoundary extends Component<
  BoundaryProps,
  {
    error: string | null;
    page: RegisteredPage;
    navigation: PageProps["navigation"];
  }
> {
  state = {
    error: null as string | null,
    page: this.props.page,
    navigation: this.props.navigation,
  };
  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: PageBoundary["state"],
  ) {
    // A new attempt or registration can retry a failed subtree, even within one visit.
    // Do not remount healthy content on a reclick: its local drafts/focus still belong to it.
    if (props.page !== state.page || props.navigation !== state.navigation)
      return { error: null, page: props.page, navigation: props.navigation };
    return null;
  }
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  componentDidCatch() {
    this.props.navigation?.complete({
      status: "failed",
      reason: "unavailable",
    });
  }
  render() {
    return this.state.error ? (
      <Failure message={this.state.error} />
    ) : (
      this.props.children
    );
  }
}
function Failure({ message }: { message: string }) {
  return (
    <div role="alert" className="notice">
      <h2>This page couldn’t open</h2>
      <p>{message}</p>
      <p>Open Settings to disable, delete, or roll back this plugin.</p>
    </div>
  );
}
export const PageView = memo(function PageView({
  page,
  companion,
  companionOpening,
  navigation,
}: { page: RegisteredPage } & PageProps) {
  return (
    <PageBoundary
      page={page}
      navigation={navigation}
      key={`${page.key}:${page.revision}`}
    >
      <PresentedPage
        page={page}
        companion={companion}
        companionOpening={companionOpening}
        navigation={navigation}
      />
    </PageBoundary>
  );
});
function PresentedPage({
  page,
  companion,
  companionOpening,
  navigation,
}: { page: RegisteredPage } & PageProps) {
  const Page = page.component;
  useEffect(() => {
    // This effect lives INSIDE the boundary: failed rendering never acknowledges mount.
    if (!page.handlesNavigation) navigation?.complete({ status: "opened" });
  }, [page, navigation]);
  return (
    <Page
      companion={companion}
      companionOpening={companionOpening}
      navigation={navigation}
    />
  );
}
