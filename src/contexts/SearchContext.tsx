/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  createContext,
  useContext,
  ReactNode,
  useState,
  useEffect,
  useRef,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  DeserializedSearchResult,
  SearchResponse,
  SummaryLanguage,
  SearchError, FcsMode, mmr_reranker_id, ApiV2SearchResponse
} from "../views/search/types";
import { useConfigContext } from "./ConfigurationContext";
import { sendSearchRequest } from "./sendSearchRequest";
import {
  HistoryItem,
  addHistoryItem,
  deleteHistory,
  retrieveHistory,
} from "./history";
import { deserializeSearchResponse } from "../utils/deserializeSearchResponse";

import { ApiV2, ApiV1, streamQueryV1, streamQueryV2 } from "@vectara/stream-query-client";
import { apiV2sendSearchRequest } from "./apiV2sendSearchRequest";
import { END_TAG, START_TAG } from "../utils/parseSnippet";

interface SearchContextType {
  filterValue: string;
  setFilterValue: (source: string) => void;
  searchValue: string;
  setSearchValue: (value: string) => void;
  modeValue: string;
  setModeValue: (value: string) => void;
  onSearch: ({
               value,
               filter,
               language,
               modifiedFcsMode,
               isPersistable,
             }: {
    value?: string;
    filter?: string;
    language?: SummaryLanguage;
    modifiedFcsMode?: FcsMode,
    isPersistable?: boolean;
    mode?: string;
    promptName?: string
  }) => void;
  reset: () => void;
  isSearching: boolean;
  searchError: SearchError | undefined;
  searchResults: DeserializedSearchResult[] | undefined;
  searchTime: number;
  enableStreamQuery: boolean | undefined;
  isSummarizing: boolean;
  summarizationError: SearchError | undefined;
  summarizationResponse: string | undefined;
  summaryTime: number;
  factualConsistencyScore: number | undefined;
  language: SummaryLanguage;
  summaryNumResults: number;
  summaryNumSentences: number;
  summaryPromptName: string;
  summaryPromptText?: string;
  fcsMode: FcsMode;
  history: HistoryItem[];
  clearHistory: () => void;
  searchResultsRef: React.MutableRefObject<HTMLElement[] | null[]>;
  selectedSearchResultPosition: number | undefined;
  selectSearchResultAt: (position: number) => void;
  relatedContent: boolean;
}

const SearchContext = createContext<SearchContextType | undefined>(undefined);

const getQueryParam = (urlParams: URLSearchParams, key: string) => {
  const value = urlParams.get(key);
  if (value) return decodeURIComponent(value);
  return undefined;
};

type Props = {
  children: ReactNode;
};

let searchCount = 0;

export const SearchContextProvider = ({ children }: Props) => {
  const { isConfigLoaded, search, summary, setSummary, results, rerank, hybrid, uxMode, fcsMode } =
    useConfigContext();
  const isSummaryEnabled = uxMode === "summary";

  const [searchValue, setSearchValue] = useState<string>("");
  const [filterValue, setFilterValue] = useState("");
  const [modeValue, setModeValue] = useState("");

  const [searchParams, setSearchParams] = useSearchParams();

  // Language
  const [languageValue, setLanguageValue] = useState<SummaryLanguage>();

  // History
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Basic search
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<SearchError | undefined>();
  const [searchResponse, setSearchResponse] = useState<SearchResponse | ApiV2.Query.SearchResult[]>();
  const [searchTime, setSearchTime] = useState<number>(0);

  // Summarization
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summarizationError, setSummarizationError] = useState<
    SearchError | undefined
  >();
  const [summarizationResponse, setSummarizationResponse] =
    useState<string>();
  const [summaryTime, setSummaryTime] = useState<number>(0);
  const [factualConsistencyScore, setFactualConsistencyScore] = useState<number | undefined>();

  // Citation selection
  const searchResultsRef = useRef<HTMLElement[] | null[]>([]);
  const [selectedSearchResultPosition, setSelectedSearchResultPosition] =
    useState<number>();

  useEffect(() => {
    setHistory(retrieveHistory());
  }, []);

  // Use the browser back and forward buttons to traverse history
  // of searches, and bookmark or share the URL.
  useEffect(() => {
    // Search params are updated as part of calling onSearch, so we don't
    // want to trigger another search when the search params change if that
    // search is already in progress.

    if (!isConfigLoaded || isSearching) return;

    const urlParams = new URLSearchParams(searchParams);
    onSearch({
      // Set to an empty string to wipe out any existing search value.
      value: getQueryParam(urlParams, "query") ?? "",
      filter: getQueryParam(urlParams, "filter"),
      language: getQueryParam(urlParams, "language") as
        | SummaryLanguage
        | undefined,
      isPersistable: false,
      mode: getQueryParam(urlParams, "mode") ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigLoaded, searchParams]);

  const searchResults = deserializeSearchResponse(searchResponse);

  useEffect(() => {
    if (searchResults) {
      searchResultsRef.current = searchResultsRef.current.slice(
        0,
        searchResults.length
      );
    } else {
      searchResultsRef.current = [];
    }
  }, [searchResults]);

  const clearHistory = () => {
    setHistory([]);
    deleteHistory();
  };

  const selectSearchResultAt = (position: number) => {
    if (
      !searchResultsRef.current[position] ||
      selectedSearchResultPosition === position
    ) {
      // Reset selected position.
      setSelectedSearchResultPosition(undefined);
    } else {
      setSelectedSearchResultPosition(position);
      // Scroll to the selected search result.
      window.scrollTo({
        top: searchResultsRef.current[position]!.offsetTop - 78,
        behavior: "smooth",
      });
    }
  };

  const getLanguage = (): SummaryLanguage =>
    (languageValue ?? summary.defaultLanguage) as SummaryLanguage;

  const onSearch = async ({
    value = searchValue,
    filter = filterValue,
    language = getLanguage(),
    modifiedFcsMode = fcsMode,
    isPersistable = true,
    mode = modeValue,
    promptName = summary.summaryPromptName
  }: {
    value?: string;
    filter?: string;
    language?: SummaryLanguage;
    modifiedFcsMode?: FcsMode
    isPersistable?: boolean;
    mode?: string;
    promptName?: string
  }) => {
    const searchId = ++searchCount;

    setSearchValue(value);
    setFilterValue(filter);
    setLanguageValue(language);
    setModeValue(mode);
    setSummary({...summary, summaryPromptName: promptName})
    const isFactualConsistentScoreEnabled = modifiedFcsMode === "score" || modifiedFcsMode === "badge"

    if (value?.trim()) {
      // Save to history.
      setHistory(addHistoryItem({ query: value, filter, language, mode }, history));

      // Persist to URL, only if the search executes. This way the prior
      // search that was persisted remains in the URL if the search doesn't execute.
      if (isPersistable) {
        setSearchParams(
          new URLSearchParams(
            `?query=${encodeURIComponent(value)}&filter=${encodeURIComponent(
              filter
            )}&language=${encodeURIComponent(language)}&mode=${encodeURIComponent(mode)}`
          )
        );
      }

      // First call - only search results - should come back quicky while we wait for summarization
      setIsSearching(true);
      setIsSummarizing(true);
      setSelectedSearchResultPosition(undefined);
      if (search.corpusKey) {
        if (search.enableStreamQuery) {
          try {
            const startTime = Date.now();
            const onStreamEvent = (event: ApiV2.StreamEvent) => {
              if (searchId === searchCount) {
                switch (event.type) {
                  case "requestError":
                  case "genericError":
                  case "error":
                    setIsSearching(false);
                    setSearchResponse(undefined);
                    break;

                  case "searchResults":
                    setSearchResponse(event.searchResults)
                    setIsSearching(false);
                    setSearchTime(Date.now() - startTime);

                    break;

                  case "generationChunk":
                    setSummarizationError(undefined);
                    setSummarizationResponse(event.updatedText ?? undefined);
                    break;

                  case "factualConsistencyScore":
                    setFactualConsistencyScore(event.factualConsistencyScore > 0 ? event.factualConsistencyScore : undefined)
                    break;

                  case "end":
                    setIsSummarizing(false);
                    setSummaryTime(Date.now() - startTime);
                    break;
                }
              }
            };

            const streamQueryConfig: ApiV2.StreamQueryConfig = {
              apiKey: search.apiKey!,
              customerId: search.customerId!,
              query: value,
              corpusKey: search.corpusKey!,
              domain: `https://${search.endpoint!}`,
              search: {
                limit: rerank.numResults,
                offset: 0,
                metadataFilter: filter,
                lexicalInterpolation:
                  value.trim().split(" ").length > hybrid.numWords ? hybrid.lambdaLong : hybrid.lambdaShort,
                reranker: rerank.isEnabled ? (rerank.id === mmr_reranker_id
                  ? {
                    type: "mmr",
                    diversityBias: rerank.diversityBias || 0
                  }
                  : {
                    type: "customer_reranker",
                    // rnk_ prefix needed for conversion from API v1 to v2.
                    rerankerId: `rnk_${rerank.id}`
                  }) : { type: "none" },
                contextConfiguration: {
                  sentencesBefore: summary.summaryNumSentences,
                  sentencesAfter: summary.summaryNumSentences,
                  startTag: START_TAG,
                  endTag: END_TAG
                }
              },
              generation: {
                promptName: promptName,
                promptText: summary.summaryPromptText,
                maxUsedSearchResults: summary.summaryNumResults,
                enableFactualConsistencyScore: isFactualConsistentScoreEnabled,
                responseLanguage: language

              }
            };

            await streamQueryV2({ streamQueryConfig, onStreamEvent })

          } catch (error) {
            console.log("Summary error", error);
            console.log("Search error", error);
            setIsSearching(false);
            setSearchError(error as SearchError);
            setSearchResponse(undefined);
            setIsSummarizing(false);
            setSummarizationError(error as SearchError);
            setSummarizationResponse(undefined);
            return;
          }
        }
        else {
          try {
            const startTime = Date.now();
            const response: ApiV2SearchResponse = await apiV2sendSearchRequest({
              apiKey: search.apiKey!,
              customerId: search.customerId!,
              query: value,
              corpusKey: search.corpusKey!,
              endpoint: search.endpoint!,
              search: {
                limit: rerank.numResults,
                offset: 0,
                metadataFilter: filter,
                lexicalInterpolation:
                  value.trim().split(" ").length > hybrid.numWords ? hybrid.lambdaLong : hybrid.lambdaShort,
                reranker: rerank.isEnabled ? (rerank.id === mmr_reranker_id
                  ? {
                    type: "mmr",
                    diversityBias: rerank.diversityBias || 0
                  }
                  : {
                    type: "customer_reranker",
                    // rnk_ prefix needed for conversion from API v1 to v2.
                    rerankerId: `rnk_${rerank.id}`
                  }) : { type: "none" },
                contextConfiguration: {
                  sentencesBefore: summary.summaryNumSentences,
                  sentencesAfter: summary.summaryNumSentences,
                  startTag: START_TAG,
                  endTag: END_TAG
                }
              },
              generation: {
                promptName: promptName,
                promptText: summary.summaryPromptText,
                maxUsedSearchResults: summary.summaryNumResults,
                enableFactualConsistencyScore: isFactualConsistentScoreEnabled,
                responseLanguage: language

              }
            })
            const totalTime = Date.now() - startTime;
            if (searchId === searchCount) {
              setSearchResponse(response.search_results)
              setIsSearching(false);
              setSearchTime(totalTime);
              setIsSummarizing(false);
              setSummarizationError(undefined);
              setSummarizationResponse(response.summary);
              setSummaryTime(totalTime);
              setFactualConsistencyScore(response.factual_consistency_score > 0 ? response.factual_consistency_score : undefined)

            }
          }catch (error) {
            console.log("Search error", error);
            setIsSearching(false);
            setSearchError(error as SearchError);
            setSearchResponse(undefined);
            setIsSummarizing(false);
            setSummarizationError(error as SearchError);
            setSummarizationResponse(undefined);
          }
        }

      }
      else {
        let initialSearchResponse;
        try {
          const startTime = Date.now();
          initialSearchResponse = await sendSearchRequest({
            filter,
            query_str: value,
            rerank: rerank.isEnabled,
            rerankNumResults: rerank.numResults,
            rerankerId: rerank.id,
            rerankDiversityBias: rerank.diversityBias,
            hybridNumWords: hybrid.numWords,
            hybridLambdaLong: hybrid.lambdaLong,
            hybridLambdaShort: hybrid.lambdaShort,
            mode: mode,
            customerId: search.customerId!,
            corpusId: search.corpusId!,
            endpoint: search.endpoint!,
            apiKey: search.apiKey!,
            logQuery: true
          });
          const totalTime = Date.now() - startTime;

          // If we send multiple requests in rapid succession, we only want to
          // display the results of the most recent request.
          if (searchId === searchCount) {
            setIsSearching(false);
            setSearchTime(totalTime);
            setSearchResponse(initialSearchResponse);

            if (initialSearchResponse.response.length > 0) {
              setSearchError(undefined);
            } else {
              setSearchError({
                message: "There weren't any results for your search.",
              });
            }
          }
        } catch (error) {
          console.log("Search error", error);
          setIsSearching(false);
          setSearchError(error as SearchError);
          setSearchResponse(undefined);
        }

        // Second call - search and summarize (if summary is enabled); this may take a while to return results
        if (isSummaryEnabled) {
          if (initialSearchResponse.response.length > 0) {
            const startTime = Date.now();
            try {
              if(search.enableStreamQuery) {
                const onStreamUpdate = (update: ApiV1.StreamUpdate) => {
                  // If we send multiple requests in rapid succession, we only want to
                  // display the results of the most recent request.
                  const fcsDetail = update.details?.factualConsistency
                  if (searchId === searchCount) {
                    if (update.isDone) {
                      setIsSummarizing(false);
                      setSummaryTime(Date.now() - startTime);
                    }
                    setSummarizationError(undefined);
                    setSummarizationResponse(update.updatedText ?? undefined);
                    setFactualConsistencyScore(fcsDetail?.score)
                  }
                };

                const hybridLambda = value === "undefined" || value.trim().split(" ").length > hybrid.numWords
                  ? hybrid.lambdaLong
                  : hybrid.lambdaShort;
                streamQueryV1(
                  {
                    filter,
                    queryValue: value,
                    rerank: rerank.isEnabled,
                    rerankNumResults: rerank.numResults,
                    rerankerId: rerank.id,
                    rerankDiversityBias: rerank.diversityBias,
                    summaryNumResults: summary.summaryNumResults,
                    summaryNumSentences: summary.summaryNumSentences,
                    summaryPromptName: promptName,
                    enableFactualConsistencyScore: isFactualConsistentScoreEnabled,
                    lambda: hybridLambda,
                    language,
                    customerId: search.customerId!,
                    corpusIds: search.corpusId!.split(","),
                    endpoint: `https://${search.endpoint!}/v1/stream-query`,
                    apiKey: search.apiKey!,
                  },
                  onStreamUpdate
                );
              }
              else {
                const response = await sendSearchRequest({
                  filter,
                  query_str: value,
                  summaryMode: true,
                  rerank: rerank.isEnabled,
                  rerankNumResults: rerank.numResults,
                  rerankerId: rerank.id,
                  rerankDiversityBias: rerank.diversityBias,
                  summaryNumResults: summary.summaryNumResults,
                  summaryNumSentences: summary.summaryNumSentences,
                  summaryPromptName: promptName,
                  summaryPromptText: summary.summaryPromptText,
                  enableFactualConsistencyScore: isFactualConsistentScoreEnabled,
                  hybridNumWords: hybrid.numWords,
                  hybridLambdaLong: hybrid.lambdaLong,
                  hybridLambdaShort: hybrid.lambdaShort,
                  language,
                  customerId: search.customerId!,
                  corpusId: search.corpusId!,
                  endpoint: search.endpoint!,
                  apiKey: search.apiKey!,
                });
                const totalTime = Date.now() - startTime;

                // If we send multiple requests in rapid succession, we only want to
                // display the results of the most recent request.
                if (searchId === searchCount) {
                  setIsSummarizing(false);
                  setSummarizationError(undefined);
                  setSummarizationResponse(response.summary[0]?.text);
                  setSummaryTime(totalTime);
                  setFactualConsistencyScore(response?.summary[0]?.factualConsistency?.score)

                }
              }
            } catch (error) {
              console.log("Summary error", error);
              setIsSummarizing(false);
              setSummarizationError(error as SearchError);
              setSummarizationResponse(undefined);
              return
            }
          } else {
            setIsSummarizing(false);
            setSummarizationError({
              message: "No search results to summarize",
            });
            setSummarizationResponse(undefined);
          }
        }
      }
    } else {
      // Persist to URL.
      if (isPersistable) setSearchParams(new URLSearchParams(""));

      setSearchResponse(undefined);
      setSummarizationResponse(undefined);
      setIsSearching(false);
      setIsSummarizing(false);
    }
  };

  const reset = () => {
    // Specifically don't reset language because that's more of a
    // user preference.
    onSearch({ value: "", filter: "", mode: "" });
  };

  return (
    <SearchContext.Provider
      value={{
        filterValue,
        setFilterValue,
        modeValue,
        setModeValue,
        searchValue,
        setSearchValue,
        onSearch,
        fcsMode,
        reset,
        isSearching,
        searchError,
        searchResults,
        searchTime,
        isSummarizing,
        summarizationError,
        summarizationResponse,
        summaryTime,
        enableStreamQuery: search.enableStreamQuery,
        factualConsistencyScore,
        language: getLanguage(),
        summaryNumResults: summary.summaryNumResults,
        summaryNumSentences: summary.summaryNumSentences,
        summaryPromptName: summary.summaryPromptName,
        summaryPromptText: summary.summaryPromptText,
        history,
        clearHistory,
        searchResultsRef,
        selectedSearchResultPosition,
        selectSearchResultAt,
        relatedContent: results.relatedContent,
      }}
    >
      {children}
    </SearchContext.Provider>
  );
};

export const useSearchContext = () => {
  const context = useContext(SearchContext);
  if (context === undefined) {
    throw new Error(
      "useSearchContext must be used within a SearchContextProvider"
    );
  }
  return context;
};