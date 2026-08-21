import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Input, Textarea } from "@tarojs/components";
import Taro from "@tarojs/taro";
import {
  createScript,
  fetchScriptOptions,
  type DmGuideRef,
  type ScriptCreatePayload,
  type ScriptItemCamel,
  type ScriptOptionGroup,
  type ScriptOptionTree,
} from "../../services/script";
import { ApiError } from "../../services/request";
import type { UploadResult } from "../../utils/ossMultipartUpload";
import "./index.less";

/**
 * 从 DM 指南文件名推导出候选剧本名。
 * 去掉 .pdf/.doc/.docx、去掉末尾括号备注、再剥掉「DM指南 / 主持人手册」之类的后缀。
 */
export function deriveScriptName(fileName: string): string {
  return fileName
    .replace(/\.(pdf|docx?)$/i, "")
    .replace(/[（(][^()]*[)）]\s*$/, "") // 末尾括号备注，如「年轮（精装版）」
    .replace(/[_\-－]+|\s+/g, " ")
    .replace(
      /(dm[:：]?指南|dm[:：]?手册|主持人手册|主持人指南|kp指南|kp手册|dm指南|dm手册|主持人指南)$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

interface ScriptSubmitFormProps {
  /** 是否展示（底部弹层） */
  visible: boolean;
  /** 已上传成功的 DM 指南文件信息 */
  file: UploadResult;
  /** 接口匹配到的候选剧本（可为空数组） */
  candidates: ScriptItemCamel[];
  /** 从文件名推导出的默认剧本名，未匹配时用于预填标题 */
  derivedName: string;
  onClose: () => void;
  /** 提交成功回调，拿到后端返回的剧本 */
  onSubmitted: (script: ScriptItemCamel) => void;
}

/** 空串转 undefined，避免把空字段发给后端 */
function toNum(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 逗号 / 中文逗号分隔成数组，空则返回 undefined */
function splitList(v: string): string[] | undefined {
  const arr = v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length ? arr : undefined;
}

function ScriptSubmitForm({
  visible,
  file,
  candidates,
  derivedName,
  onClose,
  onSubmitted,
}: ScriptSubmitFormProps) {
  /* ---------------- 表单字段状态 ---------------- */
  const [title, setTitle] = useState("");
  const [aliases, setAliases] = useState("");
  const [summary, setSummary] = useState("");
  const [author, setAuthor] = useState("");
  const [publisher, setPublisher] = useState("");
  const [tags, setTags] = useState("");
  const [year, setYear] = useState("");

  const [playstyles, setPlaystyles] = useState<string[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [releaseType, setReleaseType] = useState("");
  const [difficulty, setDifficulty] = useState("");

  const [playerMin, setPlayerMin] = useState("");
  const [playerMax, setPlayerMax] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [durationMax, setDurationMax] = useState("");

  /** 当前选中的匹配剧本 id；null 表示「都不是 / 手动新建」 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 仅用于防止重复提交，不绑到 disabled（原生 button disabled 时浏览器不派发 click）
  const submittingRef = useRef(false);

  /* ---------------- 字典维度 ---------------- */
  const [groups, setGroups] = useState<ScriptOptionGroup[]>([]);

  const groupOf = useCallback(
    (code: string) => groups.find((g) => g.code === code),
    [groups]
  );
  const playstyleGroup = groupOf("playstyle");
  const themeGroup = groupOf("theme");
  const releaseGroup = groupOf("release");
  const difficultyGroup = groupOf("difficulty");

  /** 把某个剧本的数据灌进表单 */
  const applyMatch = useCallback(
    (item: ScriptItemCamel | null) => {
      setTitle(item?.title ?? derivedName);
      setAliases((item?.aliases ?? []).join("，"));
      setSummary(item?.summary ?? "");
      setAuthor(item?.author ?? "");
      setPublisher(item?.publisher ?? "");
      setTags((item?.tags ?? []).join("，"));
      setYear(item?.publishedYear != null ? String(item.publishedYear) : "");
      setPlaystyles(item?.playstyles ?? []);
      setThemes(item?.themes ?? []);
      setReleaseType(item?.releaseType ?? "");
      setDifficulty(item?.difficulty ?? "");
      setPlayerMin(item?.playerMin != null ? String(item.playerMin) : "");
      setPlayerMax(item?.playerMax != null ? String(item.playerMax) : "");
      setDurationMin(item?.durationMin != null ? String(item.durationMin) : "");
      setDurationMax(item?.durationMax != null ? String(item.durationMax) : "");
    },
    [derivedName]
  );

  /* ---------------- 弹出时初始化：拉字典 + 选默认匹配 ---------------- */
  useEffect(() => {
    if (!visible) return;
    let alive = true;

    // 拉字典维度（一次性）
    fetchScriptOptions()
      .then((tree: ScriptOptionTree) => {
        if (alive) setGroups(tree.categories);
      })
      .catch(() => {
        if (alive) setGroups([]);
      });

    // 有匹配默认选中第一个（质量最高的），无匹配则标题预填推导名
    if (candidates.length > 0) {
      setSelectedId(candidates[0].id);
      applyMatch(candidates[0]);
    } else {
      setSelectedId(null);
      applyMatch(null);
    }

    return () => {
      alive = false;
    };
  }, [visible, candidates, applyMatch]);

  /* ---------------- 选择匹配剧本 ---------------- */
  const handlePickCandidate = useCallback(
    (item: ScriptItemCamel) => {
      setSelectedId(item.id);
      applyMatch(item);
    },
    [applyMatch]
  );

  const handleNewInstead = useCallback(() => {
    setSelectedId(null);
    // 保留推导名作为标题，其余清空让用户自己填
    setTitle(derivedName);
    setAliases("");
    setSummary("");
    setAuthor("");
    setPublisher("");
    setTags("");
    setYear("");
    setPlaystyles([]);
    setThemes([]);
    setReleaseType("");
    setDifficulty("");
    setPlayerMin("");
    setPlayerMax("");
    setDurationMin("");
    setDurationMax("");
  }, [derivedName]);

  /* ---------------- 字典多选 / 单选 ---------------- */
  const togglePlaystyle = (code: string) =>
    setPlaystyles((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  const toggleTheme = (code: string) =>
    setThemes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );

  /* ---------------- 提交 ---------------- */
  const handleSubmit = useCallback(async () => {
    if (!title.trim()) {
      Taro.showToast({ title: "请填写剧本名称", icon: "none" });
      return;
    }

    const payload: ScriptCreatePayload = { title: title.trim() };
    const aliasArr = splitList(aliases);
    if (aliasArr) payload.aliases = aliasArr;
    if (summary.trim()) payload.summary = summary.trim();
    if (author.trim()) payload.author = author.trim();
    if (publisher.trim()) payload.publisher = publisher.trim();
    const tagArr = splitList(tags);
    if (tagArr) payload.tags = tagArr;
    if (playstyles.length) payload.playstyles = playstyles;
    if (themes.length) payload.themes = themes;
    if (releaseType) payload.releaseType = releaseType;
    if (difficulty) payload.difficulty = difficulty;

    const pMin = toNum(playerMin);
    const pMax = toNum(playerMax);
    if (pMin != null && pMax != null) {
      payload.playerMin = pMin;
      payload.playerMax = pMax;
    }
    const dMin = toNum(durationMin);
    const dMax = toNum(durationMax);
    if (dMin != null && dMax != null) {
      payload.durationMin = dMin;
      payload.durationMax = dMax;
    }
    const yr = toNum(year);
    if (yr != null) payload.publishedYear = yr;

    // 把上传的 DM 指南一并提交，后端存进 extra.dmGuide
    const dmGuide: DmGuideRef = {
      fileId: file.fileId,
      fileName: file.fileName,
      fileUrl: file.fileUrl,
      objectKey: file.objectKey,
      fileSize: file.fileSize,
      instant: file.instant,
    };
    payload.extra = { dmGuide };

    if (submittingRef.current) return; // 防重复提交
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const created = await createScript(payload);
      // 明确反馈「数据已传给后端」，并带上剧本名，避免用户以为点了没反应
      const name = (created && (created.title as string)) || title.trim();
      Taro.showToast({ title: `已提交：${name}`, icon: "success" });
      onSubmitted(created);
    } catch (err: unknown) {
      // 把真实错误打到控制台，方便排查为什么「点了没反应」
      console.error("[ScriptSubmitForm] 提交剧本到后端失败:", err);
      const msg =
        err instanceof ApiError
          ? err.message || "提交失败，请重试"
          : "提交失败，请重试";
      Taro.showToast({ title: msg, icon: "none", duration: 2500 });
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [
    title,
    aliases,
    summary,
    author,
    publisher,
    tags,
    playstyles,
    themes,
    releaseType,
    difficulty,
    playerMin,
    playerMax,
    durationMin,
    durationMax,
    year,
    file,
    onSubmitted,
  ]);

  const hasCandidates = candidates.length > 0;

  return (
    <View
      className={`script-form-mask ${visible ? "is-open" : ""}`}
      onClick={onClose}
    >
      <View
        className="script-form-sheet"
        onClick={(e) => {
          // 阻止点表单区冒泡到遮罩导致关闭
          e.stopPropagation();
        }}
      >
        {/* 头部 */}
        <View className="sf-header">
          <Text className="sf-title">
            {hasCandidates ? "确认 / 完善剧本信息" : "补全剧本信息"}
          </Text>
          <Text className="sf-close" onClick={onClose}>
            ✕
          </Text>
        </View>

        {/* 主体 */}
        <View className="sf-body">
          {/* 已上传文件提示 */}
          <View className="sf-file">
            <Text className="sf-file-icon">📄</Text>
            <Text className="sf-file-name">{file.fileName}</Text>
            <Text className="sf-file-tag">已上传</Text>
          </View>

          {/* 匹配候选：命中后让用户点选，或选择「都不是」手动填 */}
          {hasCandidates && (
            <View className="sf-section">
              <Text className="sf-label">
                从剧本库匹配到以下结果（点选可自动填入）
              </Text>
              <View className="sf-candidates">
                {candidates.map((item) => (
                  <View
                    key={item.id}
                    className={`sf-candidate ${
                      selectedId === item.id ? "is-active" : ""
                    }`}
                    onClick={() => handlePickCandidate(item)}
                  >
                    <Text className="sf-candidate-title">{item.title}</Text>
                    {item.playerText && (
                      <Text className="sf-candidate-meta">
                        {item.playerText}
                      </Text>
                    )}
                    {item.difficultyLabel && (
                      <Text className="sf-candidate-meta">
                        {item.difficultyLabel}
                      </Text>
                    )}
                  </View>
                ))}
                <View
                  className={`sf-candidate sf-candidate-new ${
                    selectedId === null ? "is-active" : ""
                  }`}
                  onClick={handleNewInstead}
                >
                  <Text className="sf-candidate-title">都不是，我要新建</Text>
                </View>
              </View>
            </View>
          )}

          {/* 标题（必填） */}
          <View className="sf-field">
            <Text className="sf-label">
              剧本名称 <Text className="sf-required">*</Text>
            </Text>
            <Input
              className="sf-input"
              value={title}
              placeholder="请输入剧本名称"
              onInput={(e) => setTitle(e.detail.value)}
            />
          </View>

          {/* 别名 */}
          <View className="sf-field">
            <Text className="sf-label">别名 / 副标题（逗号分隔）</Text>
            <Input
              className="sf-input"
              value={aliases}
              placeholder="如：轮回，时间之轮"
              onInput={(e) => setAliases(e.detail.value)}
            />
          </View>

          {/* 简介 */}
          <View className="sf-field">
            <Text className="sf-label">简介</Text>
            <Textarea
              className="sf-textarea"
              value={summary}
              placeholder="一句话介绍这个剧本"
              onInput={(e) => setSummary(e.detail.value)}
            />
          </View>

          {/* 作者 / 发行方 */}
          <View className="sf-row">
            <View className="sf-field sf-col">
              <Text className="sf-label">作者</Text>
              <Input
                className="sf-input"
                value={author}
                placeholder="作者"
                onInput={(e) => setAuthor(e.detail.value)}
              />
            </View>
            <View className="sf-field sf-col">
              <Text className="sf-label">发行方</Text>
              <Input
                className="sf-input"
                value={publisher}
                placeholder="发行方"
                onInput={(e) => setPublisher(e.detail.value)}
              />
            </View>
          </View>

          {/* 玩法（多选） */}
          {playstyleGroup && (
            <View className="sf-field">
              <Text className="sf-label">玩法（可多选）</Text>
              <View className="sf-chips">
                {playstyleGroup.options.map((opt) => (
                  <View
                    key={opt.code}
                    className={`sf-chip ${
                      playstyles.includes(opt.code) ? "is-active" : ""
                    }`}
                    onClick={() => togglePlaystyle(opt.code)}
                  >
                    {opt.label}
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* 题材（多选） */}
          {themeGroup && (
            <View className="sf-field">
              <Text className="sf-label">题材（可多选）</Text>
              <View className="sf-chips">
                {themeGroup.options.map((opt) => (
                  <View
                    key={opt.code}
                    className={`sf-chip ${
                      themes.includes(opt.code) ? "is-active" : ""
                    }`}
                    onClick={() => toggleTheme(opt.code)}
                  >
                    {opt.label}
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* 发行方式（单选） */}
          {releaseGroup && (
            <View className="sf-field">
              <Text className="sf-label">发行方式</Text>
              <View className="sf-chips">
                {releaseGroup.options.map((opt) => (
                  <View
                    key={opt.code}
                    className={`sf-chip ${
                      releaseType === opt.code ? "is-active" : ""
                    }`}
                    onClick={() => setReleaseType(opt.code)}
                  >
                    {opt.label}
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* 难度（单选） */}
          {difficultyGroup && (
            <View className="sf-field">
              <Text className="sf-label">难度</Text>
              <View className="sf-chips">
                {difficultyGroup.options.map((opt) => (
                  <View
                    key={opt.code}
                    className={`sf-chip ${
                      difficulty === opt.code ? "is-active" : ""
                    }`}
                    onClick={() => setDifficulty(opt.code)}
                  >
                    {opt.label}
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* 人数区间 */}
          <View className="sf-row">
            <View className="sf-field sf-col">
              <Text className="sf-label">最少人数</Text>
              <Input
                className="sf-input"
                type="number"
                value={playerMin}
                placeholder="如 6"
                onInput={(e) => setPlayerMin(e.detail.value)}
              />
            </View>
            <View className="sf-field sf-col">
              <Text className="sf-label">最多人数</Text>
              <Input
                className="sf-input"
                type="number"
                value={playerMax}
                placeholder="如 7"
                onInput={(e) => setPlayerMax(e.detail.value)}
              />
            </View>
          </View>

          {/* 时长区间（分钟） */}
          <View className="sf-row">
            <View className="sf-field sf-col">
              <Text className="sf-label">最短时长(分钟)</Text>
              <Input
                className="sf-input"
                type="number"
                value={durationMin}
                placeholder="如 240"
                onInput={(e) => setDurationMin(e.detail.value)}
              />
            </View>
            <View className="sf-field sf-col">
              <Text className="sf-label">最长时长(分钟)</Text>
              <Input
                className="sf-input"
                type="number"
                value={durationMax}
                placeholder="如 300"
                onInput={(e) => setDurationMax(e.detail.value)}
              />
            </View>
          </View>

          {/* 发行年份 / 标签 */}
          <View className="sf-row">
            <View className="sf-field sf-col">
              <Text className="sf-label">发行年份</Text>
              <Input
                className="sf-input"
                type="number"
                value={year}
                placeholder="如 2024"
                onInput={(e) => setYear(e.detail.value)}
              />
            </View>
            <View className="sf-field sf-col">
              <Text className="sf-label">标签（逗号分隔）</Text>
              <Input
                className="sf-input"
                value={tags}
                placeholder="如：暴风雪山庄"
                onInput={(e) => setTags(e.detail.value)}
              />
            </View>
          </View>
        </View>

        {/* 底部操作 */}
        <View className="sf-footer">
          <View
            className="sf-btn sf-btn--cancel"
            onClick={onClose}
          >
            取消
          </View>
          <View
            className={`sf-btn sf-btn--confirm${submitting ? " is-loading" : ""}`}
            onClick={() => {
              if (submitting) return;
              handleSubmit();
            }}
          >
            {submitting ? "提交中…" : "确认并提交"}
          </View>
        </View>
      </View>
    </View>
  );
}

export default ScriptSubmitForm;
