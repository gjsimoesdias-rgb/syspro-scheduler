/* ============================================================================
   diagnose_changeover_classes.sql
   Why does the Changeover Matrix say "No product classes found"?

   Run in SSMS against the SYSPRO company DB (HFARMCompany1). Read the results
   top to bottom. Query 1 tells you which columns exist; if MakeBuyCode_len is
   NULL, skip queries 4 and 5b (that column isn't on this install). The last
   three queries show exactly which product classes each filter would return.
   ============================================================================ */
USE HFARMCompany1;   -- change if your company DB differs
GO

/* 1. Which columns exist on InvMaster? (NULL = column absent) */
SELECT
    MakeBuyCode_len  = COL_LENGTH('InvMaster','MakeBuyCode'),
    PartCategory_len = COL_LENGTH('InvMaster','PartCategory'),
    ProductClass_len = COL_LENGTH('InvMaster','ProductClass');
GO

/* 2. How many stock items carry a non-blank ProductClass at all? */
SELECT
    TotalItems    = COUNT(*),
    WithProdClass = SUM(CASE WHEN LTRIM(RTRIM(ISNULL(ProductClass,''))) <> '' THEN 1 ELSE 0 END)
FROM InvMaster;
GO

/* 3. PartCategory distribution + ProductClass counts.
      The OLD code filtered PartCategory = 'M'. If the 'M' row here has
      WithProdClass = 0 (or there is no 'M' row), that is why the matrix was empty. */
SELECT
    PartCategory,
    Items         = COUNT(*),
    WithProdClass = SUM(CASE WHEN LTRIM(RTRIM(ISNULL(ProductClass,''))) <> '' THEN 1 ELSE 0 END)
FROM InvMaster
GROUP BY PartCategory
ORDER BY Items DESC;
GO

/* 4. MakeBuyCode distribution + ProductClass counts.
      Cross-check only: this install identifies finished goods by PartCategory,
      but if PartCategory has no 'M' items with a ProductClass, compare here to
      see whether MakeBuyCode = 'M' would have. (Skip if MakeBuyCode_len = NULL.) */
SELECT
    MakeBuyCode,
    Items         = COUNT(*),
    WithProdClass = SUM(CASE WHEN LTRIM(RTRIM(ISNULL(ProductClass,''))) <> '' THEN 1 ELSE 0 END)
FROM InvMaster
GROUP BY MakeBuyCode
ORDER BY Items DESC;
GO

/* 5a. Product classes the OLD filter (PartCategory = 'M') would return. */
SELECT via_PartCategory_M = LTRIM(RTRIM(ProductClass)), Items = COUNT(*)
FROM InvMaster
WHERE LTRIM(RTRIM(ISNULL(ProductClass,''))) <> '' AND PartCategory = 'M'
GROUP BY LTRIM(RTRIM(ProductClass))
ORDER BY 1;
GO

/* 5b. Cross-check: product classes MakeBuyCode = 'M' would return.
       (Skip if MakeBuyCode_len was NULL in query 1.) */
SELECT via_MakeBuyCode_M = LTRIM(RTRIM(ProductClass)), Items = COUNT(*)
FROM InvMaster
WHERE LTRIM(RTRIM(ISNULL(ProductClass,''))) <> '' AND MakeBuyCode = 'M'
GROUP BY LTRIM(RTRIM(ProductClass))
ORDER BY 1;
GO

/* 5c. ALL product classes — what the matrix now falls back to (with a warning)
       when PartCategory = 'M' matches nothing. Non-empty if ANY item has a
       ProductClass; empty here means no item is classified yet. */
SELECT all_product_classes = LTRIM(RTRIM(ProductClass)), Items = COUNT(*)
FROM InvMaster
WHERE LTRIM(RTRIM(ISNULL(ProductClass,''))) <> ''
GROUP BY LTRIM(RTRIM(ProductClass))
ORDER BY Items DESC;
GO
